import {
  AudioSample,
  AudioSampleSource,
  BufferTarget,
  FlacOutputFormat,
  Output,
} from "mediabunny";
import { registerFlacEncoder } from "@mediabunny/flac-encoder";

type EncodeRequest = {
  type: "encode";
  pcm: ArrayBuffer;
  sampleRate: number;
};

type EncodeSuccess = {
  type: "success";
  flac: ArrayBuffer;
  durationMs: number;
};

type EncodeFailure = {
  type: "error";
  message: string;
};

const SPEECH_SAMPLE_RATE = 16_000;

async function encodeSpeechPcm({ pcm, sampleRate }: EncodeRequest) {
  const samples = new Float32Array(pcm);
  if (samples.length === 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("No microphone audio was captured.");
  }

  // Mediabunny's FLAC extension is a libFLAC WebAssembly encoder. It runs in
  // its own worker internally; this outer worker also keeps resampling and
  // muxing off the UI thread.  Mono, 16 kHz and 16-bit PCM are deliberate
  // speech/storage optimizations and do not make FLAC itself lossy.
  registerFlacEncoder();
  const target = new BufferTarget();
  const output = new Output({ format: new FlacOutputFormat(), target });
  const source = new AudioSampleSource({
    codec: "flac",
    transform: {
      numberOfChannels: 1,
      sampleRate: SPEECH_SAMPLE_RATE,
      sampleFormat: "s16",
    },
  });
  output.addAudioTrack(source);

  const sample = new AudioSample({
    data: samples,
    format: "f32-planar",
    numberOfChannels: 1,
    sampleRate,
    timestamp: 0,
  });

  try {
    await output.start();
    await source.add(sample);
    await output.finalize();
  } finally {
    sample.close();
    if (output.state !== "finalized" && output.state !== "canceled") {
      await output.cancel().catch(() => undefined);
    }
  }

  const flac = target.buffer;
  if (!flac || new Uint8Array(flac, 0, Math.min(4, flac.byteLength)).join(",") !== "102,76,97,67") {
    throw new Error("FLAC encoding did not produce a valid audio file.");
  }

  return {
    flac,
    durationMs: Math.max(1, Math.round((samples.length / sampleRate) * 1000)),
  };
}

self.addEventListener("message", (event: MessageEvent<EncodeRequest>) => {
  if (event.data.type !== "encode") return;

  void encodeSpeechPcm(event.data)
    .then(({ flac, durationMs }) => {
      const response: EncodeSuccess = { type: "success", flac, durationMs };
      self.postMessage(response, { transfer: [flac] });
    })
    .catch((error: unknown) => {
      const response: EncodeFailure = {
        type: "error",
        message: error instanceof Error ? error.message : "FLAC encoding failed.",
      };
      self.postMessage(response);
    });
});

export {};
