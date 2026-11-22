function speechProvider(value: string, name: string): "local" | "sarvam" {
  if (value === "local" || value === "sarvam") return value;
  throw new Error(`${name} must be local or sarvam.`);
}

export function speechProviders() {
  const stt = speechProvider(process.env.SARA_SPEECH_PROVIDER ?? "local", "SARA_SPEECH_PROVIDER");
  const tts = speechProvider(process.env.SARA_TTS_PROVIDER ?? stt, "SARA_TTS_PROVIDER");
  return { stt, tts };
}
