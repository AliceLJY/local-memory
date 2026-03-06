import type { Embedder } from "./embedder.js";
import type { MemoryStore } from "./store.js";
import type { PinAsset } from "./memory-assets.js";

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

export async function indexPinnedAsset(
  store: MemoryStore,
  embedder: Embedder,
  asset: PinAsset,
): Promise<void> {
  const text = buildPinnedAssetText(asset);
  const vector = await embedder.embedPassage(text);
  await store.store({
    text,
    vector,
    category: "decision",
    scope: `asset:${asset.id.slice(0, 8)}`,
    importance: 1.0,
    metadata: JSON.stringify({
      source: "asset",
      assetId: asset.id,
      title: asset.title,
      originalMemoryId: asset.source.memoryId,
      originalScope: asset.source.scope,
      tags: asset.tags,
    }),
  });
}
