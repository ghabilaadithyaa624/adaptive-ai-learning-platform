/**
 * Stage 4 — the LLM adapter.
 *
 * A thin, swappable boundary. The rest of the pipeline depends only on the
 * `TutorLlm` interface, so the actual backend is a configuration choice:
 *
 *   - "deterministic" (default): the grounded offline composer. Zero config,
 *     fully testable, safe. Used whenever no external model is configured.
 *   - "openai": any OpenAI-compatible Chat Completions endpoint, selected via
 *     env. Falls back to the deterministic composer on ANY error or timeout so
 *     the tutor never hard-fails a learner request.
 *
 * Env:
 *   TUTOR_LLM_PROVIDER   "deterministic" | "openai"   (default deterministic)
 *   TUTOR_LLM_API_KEY    API key (required for openai)
 *   TUTOR_LLM_BASE_URL   default https://api.openai.com/v1
 *   TUTOR_LLM_MODEL      default gpt-4o-mini
 *   TUTOR_LLM_TIMEOUT_MS default 12000
 *
 * The API key is read from the environment only and is never logged or returned.
 */
import { log } from "@/lib/observability";
import { deterministicTutor } from "./deterministic";
import type { TutorGenerationInput, TutorGenerationOutput, TutorLlm } from "./types";

function openAiTutor(config: {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}): TutorLlm {
  return {
    id: `openai:${config.model}`,
    async generate(input: TutorGenerationInput): Promise<TutorGenerationOutput> {
      // Structured fields (follow-ups, suggested activity) come from the
      // deterministic composer so they stay consistent and grounded; only the
      // prose body is delegated to the model.
      const base = await deterministicTutor.generate(input);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            temperature: 0.4,
            max_tokens: Math.ceil(input.maxOutputChars / 3),
            messages: input.messages,
          }),
        });
        if (!res.ok) throw new Error(`tutor llm http ${res.status}`);
        const data = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error("tutor llm empty response");
        return {
          message: content.slice(0, input.maxOutputChars),
          followUps: base.followUps,
          suggestedActivity: base.suggestedActivity,
          provider: "openai",
          model: config.model,
          usedFallback: false,
        };
      } catch (error) {
        // Never fail the learner: degrade to the deterministic composer.
        log.warn("tutor.llm_fallback", {
          provider: "openai",
          model: config.model,
          reason: error instanceof Error ? error.message : "unknown",
        });
        return { ...base, usedFallback: true };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Resolve the configured tutor LLM backend. */
export function getTutorLlm(): TutorLlm {
  const provider = (process.env.TUTOR_LLM_PROVIDER ?? "deterministic").toLowerCase();
  if (provider === "openai") {
    const apiKey = process.env.TUTOR_LLM_API_KEY;
    if (!apiKey) {
      // Configured for a real provider but no key present — stay safe + offline.
      log.warn("tutor.llm_unconfigured", { provider: "openai", reason: "missing TUTOR_LLM_API_KEY" });
      return deterministicTutor;
    }
    return openAiTutor({
      apiKey,
      baseUrl: process.env.TUTOR_LLM_BASE_URL ?? "https://api.openai.com/v1",
      model: process.env.TUTOR_LLM_MODEL ?? "gpt-4o-mini",
      timeoutMs: Number(process.env.TUTOR_LLM_TIMEOUT_MS ?? 12_000),
    });
  }
  return deterministicTutor;
}
