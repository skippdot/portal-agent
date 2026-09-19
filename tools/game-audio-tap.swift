// game-audio-tap: capture the audio of one running app (by process name) with
// ScreenCaptureKit and write it to stdout as raw 16 kHz mono float32 PCM.
// No virtual audio driver is needed; the terminal needs Screen Recording
// permission (System Settings > Privacy & Security).
//
// Build: swiftc -O -o .local/bin/game-audio-tap tools/game-audio-tap.swift
// Usage: game-audio-tap portal2.exe | python3 tools/asr-daemon.py

import AVFoundation
import Foundation
import ScreenCaptureKit

let processName = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "portal2.exe"
let byPid = Int32(ProcessInfo.processInfo.environment["TAP_PID"] ?? "") ?? -1
let sampleRate = 16000

func log(_ message: String) {
    FileHandle.standardError.write(("[audio-tap] " + message + "\n").data(using: .utf8)!)
}

final class AudioWriter: NSObject, SCStreamOutput, SCStreamDelegate {
    let out = FileHandle.standardOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid else { return }
        var blockBuffer: CMBlockBuffer?
        var bufferList = AudioBufferList()
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &bufferList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: 0,
            blockBufferOut: &blockBuffer)
        guard status == noErr else { return }
        let buffers = UnsafeMutableAudioBufferListPointer(&bufferList)
        // channelCount = 1, so the first buffer is the mono stream (float32).
        if let first = buffers.first, let data = first.mData {
            out.write(Data(bytes: data, count: Int(first.mDataByteSize)))
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        log("stream stopped: \(error.localizedDescription)")
        exit(2)
    }
}

let writer = AudioWriter()
var activeStream: SCStream?

Task {
    do {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let app = content.applications.first(where: { byPid > 0 && $0.processID == byPid }) ?? content.applications.first(where: { $0.applicationName == processName || $0.bundleIdentifier == processName })
            ?? content.applications.first(where: { $0.applicationName.lowercased().contains(processName.lowercased()) }) else {
            log("no running app named \(processName); running: \(content.applications.map { $0.applicationName }.joined(separator: ", "))")
            exit(1)
        }
        guard let display = content.displays.first else {
            log("no display")
            exit(1)
        }
        let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.sampleRate = sampleRate
        config.channelCount = 1
        config.excludesCurrentProcessAudio = true
        // Video is mandatory for a stream; keep it tiny and slow.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let stream = SCStream(filter: filter, configuration: config, delegate: writer)
        try stream.addStreamOutput(writer, type: .audio, sampleHandlerQueue: DispatchQueue(label: "audio"))
        try await stream.startCapture()
        activeStream = stream
        log("capturing audio of \(app.applicationName) (pid \(app.processID)) at \(sampleRate) Hz mono f32")
    } catch {
        log("failed: \(error.localizedDescription)")
        exit(1)
    }
}

signal(SIGPIPE, SIG_IGN)
RunLoop.main.run()
