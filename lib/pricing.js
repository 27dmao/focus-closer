// Single source of truth for model IDs, labels, and per-1M-token prices.
// Prices are USD per 1,000,000 tokens. Verify against console.anthropic.com
// before shipping — if Anthropic changes pricing, update only this file.

export const MODELS = {
  "claude-haiku-4-5-20251001": {
    label: "Haiku 4.5",
    speed: "fastest",
    in: 1,
    out: 5,
    cacheRead: 0.10,
    cacheWrite: 1.25
  },
  "claude-sonnet-4-6": {
    label: "Sonnet 4.6",
    speed: "medium",
    in: 3,
    out: 15,
    cacheRead: 0.30,
    cacheWrite: 3.75
  },
  "claude-opus-4-6": {
    label: "Opus 4.6",
    speed: "slow",
    in: 15,
    out: 75,
    cacheRead: 1.50,
    cacheWrite: 18.75
  },
  "claude-opus-4-7": {
    label: "Opus 4.7",
    speed: "slow",
    in: 15,
    out: 75,
    cacheRead: 1.50,
    cacheWrite: 18.75
  }
};

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// usage = the `usage` object returned by the Anthropic Messages API.
// Returns dollars (not per-million).
export function costForCall(usage, modelId) {
  const m = MODELS[modelId] || MODELS[DEFAULT_MODEL];
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  const cacheRead = usage?.cache_read_input_tokens || 0;
  const cacheWrite = usage?.cache_creation_input_tokens || 0;
  return (
    (input * m.in + output * m.out + cacheRead * m.cacheRead + cacheWrite * m.cacheWrite) / 1_000_000
  );
}

// Given summed token volumes, project cost across every model.
// tokens = { input, output, cacheRead, cacheWrite }
// Returns [{ id, label, speed, cost }] sorted cheapest-first.
export function projectAcrossModels(tokens) {
  return Object.entries(MODELS)
    .map(([id, m]) => ({
      id,
      label: m.label,
      speed: m.speed,
      cost:
        (tokens.input * m.in +
          tokens.output * m.out +
          tokens.cacheRead * m.cacheRead +
          tokens.cacheWrite * m.cacheWrite) / 1_000_000
    }))
    .sort((a, b) => a.cost - b.cost);
}
