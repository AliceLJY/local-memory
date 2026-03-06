import type { Embedder } from "./embedder.js";
import type { MemoryStore } from "./store.js";
import type { BriefAsset, MemoryAsset, PinAsset } from "./memory-assets.js";

function buildPinnedAssetText(asset: PinAsset): string {
  const tags = asset.tags.join(", ");
  return [
    `[Pinned Asset] ${asset.title}`,
    `Summary: ${asset.summary}`,
    `Snippet: ${asset.snippet}`,
    `Original Scope: ${asset.source.scope}`,
    tags ? `Tags: ${tags}` : "",
  ].filter(Boolean).join("\n");
}

function buildBriefAssetText(asset: BriefAsset): string {
  const tags = asset.tags.join(", ");
  return [
    `[Memory Brief] ${asset.title}`,
    `Query: ${asset.query}`,
    `Profile: ${asset.profile}`,
    `Summary: ${asset.summary}`,
    asset.takeaways.length > 0 ? `Takeaways: ${asset.takeaways.join(" | ")}` : "",
    asset.reusableCandidates.length > 0 ? `Reusable: ${asset.reusableCandidates.join(" | ")}` : "",
    asset.sources.length > 0 ? `Sources: ${asset.sources.map((item) => `${item.source}(${item.hits})`).join(", ")}` : "",
    tags ? `Tags: ${tags}` : "",
  ].filter(Boolean).join("\n");
}

function buildAssetText(asset: MemoryAsset): string {
  return asset.type === "memory-brief"
    ? buildBriefAssetText(asset)
    : buildPinnedAssetText(asset);
}

function assetImportance(asset: MemoryAsset): number {
  return asset.type === "memory-brief" ? 0.72 : 0.96;
}

export async function indexAsset(
  store: MemoryStore,
  embedder: Embedder,
  asset: MemoryAsset,
): Promise<void> {
  const text = buildAssetText(asset);
  const vector = await embedder.embedPassage(text);
  const metadata = asset.type === "memory-brief"
    ? {
        source: "asset",
        assetId: asset.id,
        assetType: asset.type,
        title: asset.title,
        query: asset.query,
        profile: asset.profile,
        tags: asset.tags,
        sources: asset.sources.map((item) => item.source),
      }
    : {
        source: "asset",
        assetId: asset.id,
        assetType: asset.type,
        title: asset.title,
        originalMemoryId: asset.source.memoryId,
        originalScope: asset.source.scope,
        tags: asset.tags,
      };
  await store.store({
    text,
    vector,
    category: "decision",
    scope: asset.type === "memory-brief"
      ? `asset:brief:${asset.id.slice(0, 8)}`
      : `asset:${asset.id.slice(0, 8)}`,
    importance: assetImportance(asset),
    metadata: JSON.stringify(metadata),
  });
}

export const indexPinnedAsset = indexAsset;
