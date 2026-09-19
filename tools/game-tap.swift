// game-tap: one ScreenCaptureKit session on the game's window that
//
//   1. streams 16 kHz mono float32 PCM to stdout (for tools/asr-daemon.py),
//   2. records the session to segmented .mp4 files (video + audio), so any
//      past moment can be re-extracted later ("rewind"),
//   3. keeps the newest frame as a JPEG on disk, so the controller and the
//      vision daemon get a frame without spawning `screencapture` (~120 ms).
//
// Build: swiftc -O -o .local/bin/game-tap tools/game-tap.swift
// Usage: game-tap --app portal2.exe [--record .local/rec] [--frames .local/frames]
//                 [--fps 10] [--segment 60] [--no-audio]
//
// Segments are named <epoch-ms>.mp4 and the newest frame is <frames>/latest.jpg
// plus <frames>/latest.json ({"t": <epoch-ms>, "w":…, "h":…}), both replaced
// atomically. The terminal needs Screen Recording permission.

import AVFoundation
import CoreImage
import Foundation
import ScreenCaptureKit

// --- Arguments --------------------------------------------------------------

var appName = "portal2.exe"
var recordDir: String? = nil
var framesDir: String? = nil
var fps = 10
var segmentSeconds = 60.0
var wantAudio = true
// The captured window includes its title bar; drop it so frames are pure game.
var cropTop = 28.0
var audioRawPath: String? = nil
let sampleRate = 16000

var it = CommandLine.arguments.dropFirst().makeIterator()
while let arg = it.next() {
    switch arg {
    case "--app": appName = it.next() ?? appName
    case "--record": recordDir = it.next()
    case "--frames": framesDir = it.next()
    case "--fps": fps = Int(it.next() ?? "") ?? fps
    case "--segment": segmentSeconds = Double(it.next() ?? "") ?? segmentSeconds
    case "--no-audio": wantAudio = false
    case "--crop-top": cropTop = Double(it.next() ?? "") ?? cropTop
    case "--audio-raw": audioRawPath = it.next()
    default: FileHandle.standardError.write("unknown argument: \(arg)\n".data(using: .utf8)!)
    }
}

func log(_ message: String) {
    FileHandle.standardError.write(("[game-tap] " + message + "\n").data(using: .utf8)!)
}

func epochMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

// --- Segmented recorder -----------------------------------------------------

// AVAssetWriter cannot append across files, so a new writer is started every
// `segmentSeconds`. Each segment is self-contained and named by its start time.
final class SegmentRecorder {
    private let dir: URL
    private let width: Int
    private let height: Int
    private let queue = DispatchQueue(label: "recorder")
    private var writer: AVAssetWriter?
    private var video: AVAssetWriterInput?
    private var audio: AVAssetWriterInput?
    private var started = false
    private var segmentStart = CMTime.zero
    private var segmentStartMs: Int64 = 0

    init(dir: URL, width: Int, height: Int) {
        self.dir = dir
        self.width = width
        self.height = height
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Remove empty segments left behind by a previous, killed run.
        for f in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? [] {
            if (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) == 0 { try? FileManager.default.removeItem(at: f) }
        }
    }

    private func begin(at time: CMTime) {
        segmentStartMs = epochMs()
        let url = dir.appendingPathComponent("\(segmentStartMs).mp4")
        guard let w = try? AVAssetWriter(outputURL: url, fileType: .mp4) else {
            log("cannot open \(url.path)")
            return
        }
        let v = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_500_000],
        ])
        v.expectsMediaDataInRealTime = true
        if w.canAdd(v) { w.add(v) }
        // Video only: ScreenCaptureKit's float32 audio is rejected by the AAC
        // encoder ("Cannot Encode Media"), so sound is kept as raw PCM next to
        // the segments (--audio-raw) and muxed with ffmpeg when a clip is cut.
        let a: AVAssetWriterInput? = nil
        w.startWriting()
        w.startSession(atSourceTime: time)
        writer = w
        video = v
        audio = a
        started = true
        segmentStart = time
    }

    private func rollIfNeeded(_ time: CMTime) {
        guard started else { return begin(at: time) }
        if (time - segmentStart).seconds >= segmentSeconds {
            finish()
            begin(at: time)
        }
    }

    func append(video buffer: CMSampleBuffer) {
        queue.async {
            let t = CMSampleBufferGetPresentationTimeStamp(buffer)
            self.rollIfNeeded(t)
            if let v = self.video, v.isReadyForMoreMediaData {
                if !v.append(buffer) {
                    log("video append failed: status \(self.writer?.status.rawValue ?? -1) \(self.writer?.error?.localizedDescription ?? "-")")
                }
            }
        }
    }

    func finish() {
        guard let w = writer else { return }
        video?.markAsFinished()
        audio?.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        w.finishWriting {
            if w.status != .completed { log("segment failed: \(w.status.rawValue) \(w.error?.localizedDescription ?? "-")") }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 5)
        writer = nil
        video = nil
        audio = nil
        started = false
    }
}

// --- Stream output ----------------------------------------------------------

final class Tap: NSObject, SCStreamOutput, SCStreamDelegate {
    let out = FileHandle.standardOutput
    let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    var recorder: SegmentRecorder?
    var audioRaw: FileHandle?
    var framesURL: URL?
    var lastFrameWrite = Date.distantPast
    let frameInterval: TimeInterval
    let frameQueue = DispatchQueue(label: "frames")

    init(frameInterval: TimeInterval) {
        self.frameInterval = frameInterval
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard sampleBuffer.isValid else { return }
        switch type {
        case .audio:
            handleAudio(sampleBuffer)
        case .screen:
            handleVideo(sampleBuffer)
        default:
            break
        }
    }

    private func handleAudio(_ sampleBuffer: CMSampleBuffer) {
        guard wantAudio else { return }
        var blockBuffer: CMBlockBuffer?
        var list = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: &list,
            bufferListSize: MemoryLayout<AudioBufferList>.size, blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &blockBuffer)
        guard status == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(&list)
        if let first = buffers.first, let data = first.mData {
            let chunk = Data(bytes: data, count: Int(first.mDataByteSize))
            out.write(chunk)
            audioRaw?.write(chunk)
        }
    }

    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        // Frames whose content did not change carry no image buffer.
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        recorder?.append(video: sampleBuffer)
        guard let framesURL, Date().timeIntervalSince(lastFrameWrite) >= frameInterval else { return }
        lastFrameWrite = Date()
        let image = CIImage(cvPixelBuffer: pixels)
        frameQueue.async { [ciContext] in
            guard let jpeg = ciContext.jpegRepresentation(
                of: image, colorSpace: CGColorSpaceCreateDeviceRGB(),
                options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.85])
            else { return }
            let t = epochMs()
            let tmp = framesURL.appendingPathComponent("latest.jpg.tmp")
            try? jpeg.write(to: tmp)
            try? FileManager.default.removeItem(at: framesURL.appendingPathComponent("latest.jpg"))
            try? FileManager.default.moveItem(at: tmp, to: framesURL.appendingPathComponent("latest.jpg"))
            let meta = #"{"t":\#(t),"w":\#(Int(image.extent.width)),"h":\#(Int(image.extent.height))}"#
            let metaTmp = framesURL.appendingPathComponent("latest.json.tmp")
            try? meta.write(to: metaTmp, atomically: false, encoding: .utf8)
            try? FileManager.default.removeItem(at: framesURL.appendingPathComponent("latest.json"))
            try? FileManager.default.moveItem(at: metaTmp, to: framesURL.appendingPathComponent("latest.json"))
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("stream stopped: \(error.localizedDescription)")
        recorder?.finish()
        exit(2)
    }
}

// --- Start ------------------------------------------------------------------

let tap = Tap(frameInterval: 1.0 / Double(max(1, fps)))
var activeStream: SCStream?

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let app = content.applications.first(where: { $0.applicationName == appName })
            ?? content.applications.first(where: { $0.applicationName.lowercased().contains(appName.lowercased()) })
        else {
            log("no running app named \(appName)")
            exit(1)
        }
        // Prefer the game's own window so the capture is not the whole display.
        let window = content.windows.first {
            $0.owningApplication?.processID == app.processID && ($0.title?.contains("Direct3D") ?? false)
        }
        let filter: SCContentFilter
        var width = 960, height = 600
        var sourceRect: CGRect? = nil
        if let window {
            filter = SCContentFilter(desktopIndependentWindow: window)
            let w = window.frame.width, h = window.frame.height - cropTop
            sourceRect = CGRect(x: 0, y: cropTop, width: w, height: h)
            width = Int(w) * 2
            height = Int(h) * 2
        } else {
            guard let display = content.displays.first else { log("no display"); exit(1) }
            filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            width = display.width * 2
            height = display.height * 2
        }
        let config = SCStreamConfiguration()
        config.capturesAudio = wantAudio
        config.sampleRate = sampleRate
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        config.queueDepth = 6
        config.showsCursor = false
        if let sourceRect {
            config.sourceRect = sourceRect
            config.scalesToFit = false
        }

        if let recordDir {
            tap.recorder = SegmentRecorder(dir: URL(fileURLWithPath: recordDir), width: width, height: height)
        }
        if let audioRawPath {
            FileManager.default.createFile(atPath: audioRawPath, contents: nil)
            tap.audioRaw = FileHandle(forWritingAtPath: audioRawPath)
            tap.audioRaw?.seekToEndOfFile()
        }
        if let framesDir {
            try? FileManager.default.createDirectory(atPath: framesDir, withIntermediateDirectories: true)
            tap.framesURL = URL(fileURLWithPath: framesDir)
        }

        let stream = SCStream(filter: filter, configuration: config, delegate: tap)
        try stream.addStreamOutput(tap, type: .screen, sampleHandlerQueue: DispatchQueue(label: "video"))
        if wantAudio {
            try stream.addStreamOutput(tap, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio"))
        }
        try await stream.startCapture()
        activeStream = stream
        log("capturing \(app.applicationName) \(width)x\(height) @\(fps)fps"
            + (recordDir.map { " -> \($0)" } ?? "") + (framesDir.map { " frames: \($0)" } ?? ""))
    } catch {
        log("failed: \(error.localizedDescription)")
        exit(1)
    }
}

// Finish the current segment on Ctrl-C / SIGTERM so it stays playable.
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        tap.recorder?.finish()
        exit(0)
    }
    source.resume()
}
signal(SIGPIPE, SIG_IGN)
RunLoop.main.run()
