// Fetches human-readable market metadata from Polymarket Gamma API.
// Used as a fallback when WS payload omits title/outcome fields.

const GAMMA_API = "https://gamma-api.polymarket.com";
// In-memory cache: tokenId → metadata (no TTL needed — market titles don't change)
const cache = new Map<string, { title: string; outcome: string; slug: string }>();

export async function enrichSignalMetadata(
  tokenId: string,
  conditionId: string,
): Promise<{ title?: string; outcome?: string; slug?: string }> {
  const cached = cache.get(tokenId);
  if (cached) return cached;

  try {
    const res = await fetch(
      `${GAMMA_API}/markets?clob_token_ids=${tokenId}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return {};

    const data = (await res.json()) as Array<{
      question?: string;
      groupItemTitle?: string;
      slug?: string;
      outcomes?: string[];
      clobTokenIds?: string[];
    }>;

    if (!Array.isArray(data) || data.length === 0) return {};

    const market = data[0];
    // clobTokenIds is a JSON-encoded array — find the index of our tokenId
    let outcomeIndex = 0;
    try {
      const ids: string[] = JSON.parse(market.clobTokenIds as unknown as string ?? "[]");
      outcomeIndex = ids.indexOf(tokenId);
    } catch {}

    const outcomes: string[] = Array.isArray(market.outcomes)
      ? market.outcomes
      : JSON.parse((market.outcomes as unknown as string) ?? "[]");

    const meta = {
      title: market.question ?? market.groupItemTitle ?? "Unknown market",
      outcome: outcomes[outcomeIndex] ?? "Unknown",
      slug: market.slug ?? conditionId.slice(0, 12),
    };

    cache.set(tokenId, meta);
    return meta;
  } catch {
    return {};
  }
}
