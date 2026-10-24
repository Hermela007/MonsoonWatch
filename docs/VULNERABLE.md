# Vulnerable residents — data sources & honesty notes

`Village.vulnerable` holds **counts only** (bedridden, disabled, elderly, noTransport), never names or addresses.
Every village's counts are **estimates** (`estimated: true`) = village population × a rate. Village populations are themselves mostly OpenStreetMap-based estimates (`populationEstimated`).

| Category | Rate | Official? | Source |
|---|---|---|---|
| Elderly (60+) | 10.2% | Yes, Kelantan | DOSM Kelantan newsletter Siri 80 (2020e: 194.3k of 1,906.7k) — https://v1.dosm.gov.my/v1/uploads/files/6_Newsletter/Newsletter%202020/DOSM_DOSM.KELANTAN_1.2020_Siri-80.pdf |
| Disabled | ~2.2% | Yes, but **national** (Kelantan figure not yet found) | JKM: 756,681 registered OKU (2024, Dewan Negara written reply) ÷ ~34M population — https://ova.galencentre.org/756681-persons-with-disabilities-oku-registered-with-jkm-as-of-january-31-2024/ |
| No transport | 7.7% | Yes, but **national**, and a proxy (households without a car) | DOSM Household Income & Basic Amenities 2024 (92.3% of households own a car) — https://www.dosm.gov.my/portal-main/release-content/basic-amenities-survey-report-malaysia-2024 |
| Bedridden | 0 | **No official statistic found** | Set only on demo-scenario villages (below). |

**Demo scenario** (`scripts/data/vulnerable/demo-scenario.json`): Manek Urai (3 bedridden) and Kuala Gris (2 bedridden) — illustrative values for the vulnerable-people demo beat, labelled "DEMO SCENARIO" in `vulnerable.source`. Not real data.

To do: replace the national rates with Kelantan figures (JKM OKU by state) and find an official bedridden/home-care source (e.g. Ministry of Health). Edit `scripts/data/vulnerable/rates.json` and re-run `pnpm load:vulnerable`.
