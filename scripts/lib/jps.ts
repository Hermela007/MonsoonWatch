// JPS (publicinfobanjir.water.gov.my) sources — URLs verified in docs/GUIDELINES.md §4.
export const JPS_URLS = {
  river: "https://publicinfobanjir.water.gov.my/aras-air/data-paras-air/aras-air-data/?state=KEL&district=ALL&station=ALL&lang=en",
  rain: "https://publicinfobanjir.water.gov.my/wp-content/themes/shapely/agency/searchresultrainfall.php?state=KEL&district=ALL&station=ALL&loginStatus=0&language=1",
} as const;

export type JpsKind = keyof typeof JPS_URLS;

export async function fetchJpsHtml(kind: JpsKind): Promise<string> {
  const res = await fetch(JPS_URLS[kind], {
    headers: { "User-Agent": "Mozilla/5.0 (MonsoonWatch hackathon; flood early warning)", Accept: "text/html" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`JPS ${kind}: HTTP ${res.status}`);
  return redactKeys(await res.text());
}

/** JPS pages embed their own public Google Maps browser key. Strip API keys so saved snapshots
 *  never put third-party keys in our repo (GitHub secret scanning flags them). */
export function redactKeys(html: string): string {
  return html.replace(/AIza[0-9A-Za-z_-]{20,}/g, "REDACTED_BY_MONSOONWATCH");
}
