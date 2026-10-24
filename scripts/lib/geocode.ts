// Pure helpers for geocoding JPS station names.

export const DISTRICT_CENTRES: Record<string, [number, number]> = {
  "Gua Musang": [101.97, 4.88], "Kuala Krai": [102.2, 5.53], Jeli: [101.84, 5.7], "Tanah Merah": [102.15, 5.8],
  Machang: [102.22, 5.76], "Pasir Mas": [102.14, 6.05], "Kota Bharu": [102.24, 6.13], Tumpat: [102.17, 6.2],
  Bachok: [102.4, 6.07], "Pasir Puteh": [102.4, 5.84],
};

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bKg\./gi, "Kampung"], [/\bSg\./gi, "Sungai"], [/\bSek\. ?Keb\./gi, "Sekolah Kebangsaan"], [/\bS\.M\b\.?/gi, "Sekolah Menengah"],
  [/\bLdg\./gi, "Ladang"], [/\bEmp\./gi, "Empangan"], [/\bPej\./gi, "Pejabat"], [/\bTg\./gi, "Tanjung"],
  [/\bBtg\./gi, "Batang"], [/\bBkt\./gi, "Bukit"], [/\bAbd\./gi, "Abdul"], [/\bJln\./gi, "Jalan"],
];

/** "Sg. Galas di Kg. Lembaga (F1)" → ["Kampung Lembaga", "Lembaga"] ; "Kg. Tandak (Bkt. P.Junu di Kelantan)" → ["Kampung Tandak", …] */
export function placeCandidates(name: string): string[] {
  let s = name.replace(/\((F\d|RHN)\)/gi, "").replace(/\s+di Kelantan\b/i, "").trim();
  s = s.replace(/\(.*?\)/g, "").trim();
  if (/ di /i.test(s)) s = s.split(/ di /i).slice(1).join(" di ");
  const parts = s.split(",").map((p) => p.trim()).filter(Boolean).reverse(); // "Loji…, Kg. Chetil" → try "Kg. Chetil" first
  const out = new Set<string>();
  for (const p of parts) {
    let expanded = p;
    for (const [re, full] of ABBREVIATIONS) expanded = expanded.replace(re, full);
    out.add(expanded);
    // progressively barer versions: drop facility words and trailing numbers, then the last two words
    const bare = expanded
      .replace(/^(Kampung|Jambatan|Empangan|Ladang|Felda|Jalan|Rumah Pam|JPS|Ibu Bekalan|Pejabat Pertanian|Sekolah Kebangsaan|Sekolah Menengah|Loji Janakuasa|Tanjung Abdul Rahman)\s+/gi, "")
      .replace(/^(Felda|JPS)\s+/i, "")
      .replace(/\s+(\d+|Sdn\.? Bhd\.?|Plantation)$/gi, "")
      .replace(/\s+(\d+|Sdn\.? Bhd\.?|Plantation)$/gi, "")
      .trim();
    out.add(bare);
    const words = bare.split(/\s+/);
    if (words.length > 2) out.add(words.slice(-2).join(" "));
  }
  return [...out].filter((p) => p.length > 2);
}
