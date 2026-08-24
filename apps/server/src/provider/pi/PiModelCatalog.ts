import type { ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { PI_THINKING_LEVELS, type PiModel, type PiThinkingLevel } from "./PiRpcProtocol.ts";

export const PI_THINKING_LEVEL_OPTION_ID = "thinkingLevel";

export interface PiModelIdentity {
  readonly provider: string;
  readonly modelId: string;
}

export class PiModelSlugDecodeError extends Schema.TaggedErrorClass<PiModelSlugDecodeError>()(
  "PiModelSlugDecodeError",
  {
    slug: Schema.String,
    detail: Schema.String,
  },
) {}

export function encodePiModelSlug(identity: PiModelIdentity): string {
  return `${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.modelId)}`;
}

export function decodePiModelSlug(
  slug: string,
): Result.Result<PiModelIdentity, PiModelSlugDecodeError> {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator !== slug.lastIndexOf("/") || separator === slug.length - 1) {
    return Result.fail(
      new PiModelSlugDecodeError({
        slug,
        detail: "Expected one separator between non-empty provider and model components.",
      }),
    );
  }

  try {
    const provider = decodeURIComponent(slug.slice(0, separator));
    const modelId = decodeURIComponent(slug.slice(separator + 1));
    if (provider.length === 0 || modelId.length === 0) {
      return Result.fail(
        new PiModelSlugDecodeError({
          slug,
          detail: "Provider and model components must decode to non-empty values.",
        }),
      );
    }
    return Result.succeed({ provider, modelId });
  } catch {
    return Result.fail(
      new PiModelSlugDecodeError({ slug, detail: "The slug contains a malformed percent escape." }),
    );
  }
}

/** Mirrors pi-ai's getSupportedThinkingLevels model compatibility semantics. */
export function getPiSupportedThinkingLevels(model: PiModel): ReadonlyArray<PiThinkingLevel> {
  if (!model.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

const THINKING_DESCRIPTIONS: Readonly<Record<PiThinkingLevel, string>> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

function sameModel(left: PiModel | null | undefined, right: PiModel): boolean {
  return left?.provider === right.provider && left.id === right.id;
}

export function mapPiModels(input: {
  readonly models: ReadonlyArray<PiModel>;
  readonly currentModel?: PiModel | null;
  readonly currentThinkingLevel?: PiThinkingLevel;
  readonly activeThinkingLevels?: ReadonlyArray<PiThinkingLevel>;
}): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const mapped: ServerProviderModel[] = [];

  for (const model of input.models) {
    const slug = encodePiModelSlug({ provider: model.provider, modelId: model.id });
    if (seen.has(slug)) continue;
    seen.add(slug);

    const isActive = sameModel(input.currentModel, model);
    const levels = isActive
      ? (input.activeThinkingLevels ?? getPiSupportedThinkingLevels(model))
      : getPiSupportedThinkingLevels(model);
    const optionDescriptors =
      model.reasoning && levels.length > 0
        ? [
            {
              id: PI_THINKING_LEVEL_OPTION_ID,
              label: "Thinking",
              type: "select" as const,
              options: levels.map((level) => ({
                id: level,
                label: level,
                description: THINKING_DESCRIPTIONS[level],
              })),
              ...(isActive &&
              input.currentThinkingLevel !== undefined &&
              levels.includes(input.currentThinkingLevel)
                ? { currentValue: input.currentThinkingLevel }
                : {}),
            },
          ]
        : [];

    mapped.push({
      slug,
      name: model.name.trim() || model.id,
      subProvider: model.provider,
      isCustom: false,
      ...(isActive ? { isDefault: true } : {}),
      capabilities: createModelCapabilities({ optionDescriptors }),
    });
  }

  return mapped;
}
