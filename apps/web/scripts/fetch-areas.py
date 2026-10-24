"""
Real buildings + roads for the demo areas -> apps/web/public/data/areas/<slug>.json

  buildings: Overture Maps (release 2026-10-21.0, theme=buildings) — merges OpenStreetMap,
             Microsoft and Google footprints. ODbL / CDLA. Heights are mostly absent here.
  roads:     OpenStreetMap highways from Workstream C's committed cache
             scripts/data/osm/geo.kelantan.json.gz

Usage (needs duckdb):  python3 apps/web/scripts/fetch-areas.py
"""
import gzip, json, math, os, re, sys
import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
OUT = os.path.join(HERE, '..', 'public', 'data', 'areas')
RELEASE = '2026-10-21.0'
HALF = 0.0068  # degrees, ~750 m each way

places = {v['name']: v for v in json.load(open(os.path.join(HERE, '..', 'public', 'data', 'kelantan.json')))['villages']}
NAMES = sys.argv[1:] or ['Kuala Krai', 'Dabong', 'Tanah Merah', 'Kota Bharu', 'Pasir Mas', 'Gua Musang', 'Kampung Kubur Datu', 'Kampung Sungai Batu']
areas = []
for n in NAMES:
    if n not in places:
        print('not found:', n); continue
    lon, lat = places[n]['lngLat']
    areas.append({'name': n, 'slug': re.sub(r'[^a-z0-9]+', '-', n.lower()).strip('-'), 'center': [lon, lat],
                  'bbox': [lon - HALF, lat - HALF, lon + HALF, lat + HALF]})

con = duckdb.connect()
con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';")
# One query per area: a single bbox range lets DuckDB skip row groups (OR-ing boxes scans everything).
rows = []
for a in areas:
    b = a['bbox']
    part = con.execute(f"""
      SELECT id, ST_AsGeoJSON(geometry) AS g, height, num_floors, class, bbox.xmin, bbox.ymin
      FROM read_parquet('s3://overturemaps-us-west-2/release/{RELEASE}/theme=buildings/type=building/*', hive_partitioning=1)
      WHERE bbox.xmin BETWEEN {b[0]} AND {b[2]} AND bbox.ymin BETWEEN {b[1]} AND {b[3]}
    """).fetchall()
    print(a['name'], 'buildings fetched', len(part), flush=True)
    rows += part

def r6(x): return round(x, 6)
for a in areas: a['buildings'] = []
for (bid, g, height, floors, cls, x, y) in rows:
    geom = json.loads(g)
    rings = geom['coordinates'] if geom['type'] == 'Polygon' else geom['coordinates'][0] if geom['type'] == 'MultiPolygon' else None
    if not rings: continue
    outer = [[r6(p[0]), r6(p[1])] for p in rings[0]]
    for a in areas:
        b = a['bbox']
        if b[0] <= x <= b[2] and b[1] <= y <= b[3]:
            a['buildings'].append({'id': bid, 'ring': outer, 'height': height, 'floors': floors, 'class': cls})

# Roads from C's OSM cache.
osm = json.load(gzip.open(os.path.join(ROOT, 'scripts', 'data', 'osm', 'geo.kelantan.json.gz')))['elements']
nodes = {e['id']: (e['lon'], e['lat']) for e in osm if e['type'] == 'node'}
for a in areas: a['roads'] = []
for e in osm:
    if e['type'] != 'way' or 'highway' not in e.get('tags', {}): continue
    coords = [nodes[n] for n in e.get('nodes', []) if n in nodes]
    if len(coords) < 2: continue
    for a in areas:
        b = a['bbox']
        if any(b[0] - 0.003 <= c[0] <= b[2] + 0.003 and b[1] - 0.003 <= c[1] <= b[3] + 0.003 for c in coords):
            a['roads'].append({'id': e['id'], 'kind': e['tags']['highway'], 'name': e['tags'].get('name'), 'line': [[r6(c[0]), r6(c[1])] for c in coords]})

os.makedirs(OUT, exist_ok=True)
index = []
for a in areas:
    out = {'name': a['name'], 'center': a['center'], 'bbox': a['bbox'],
           'source': {'buildings': f'Overture Maps {RELEASE} (OpenStreetMap, Microsoft, Google; ODbL/CDLA)', 'roads': 'OpenStreetMap contributors (ODbL) via Workstream C'},
           'buildings': a['buildings'], 'roads': a['roads']}
    json.dump(out, open(os.path.join(OUT, a['slug'] + '.json'), 'w'), separators=(',', ':'))
    index.append({'name': a['name'], 'slug': a['slug'], 'center': a['center'], 'buildings': len(a['buildings']), 'roads': len(a['roads'])})
    print(a['name'], len(a['buildings']), 'buildings', len(a['roads']), 'roads')
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
