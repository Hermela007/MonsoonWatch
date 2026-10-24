import type { SearchResponse } from '@monsoonwatch/shared';
import type { LngLat } from '../geo/region';

export function createKnowledgeSearch(root: HTMLElement, flyTo: (ll: LngLat) => void) {
  let revision = 0, enabled = false;
  let controller: AbortController | undefined;
  const form = document.createElement('form');
  const input = document.createElement('input'); input.type = 'search'; input.minLength = 2; input.maxLength = 200; input.required = true; input.placeholder = 'Ask the flood history and response plans'; input.setAttribute('aria-label', 'Search places or knowledge');
  const type = document.createElement('select'); type.setAttribute('aria-label', 'Search type');
  for (const [value, title] of [['hybrid', 'Knowledge'], ['place', 'Places']]) { const option = document.createElement('option'); option.value = value; option.textContent = title; type.append(option); }
  const button = document.createElement('button'); button.type = 'submit'; button.className = 'btn'; button.textContent = 'Search';
  const status = document.createElement('p'); status.className = 'note'; status.setAttribute('role', 'status');
  const results = document.createElement('ol'); results.className = 'knowledge-results';
  form.append(input, type, button); root.append(form, status, results);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!enabled || input.value.trim().length < 2) return;
    const mine = ++revision; controller?.abort(); controller = new AbortController();
      const activeController = controller;
    const timeout = setTimeout(() => activeController.abort(), 30000);
    button.disabled = true; results.replaceChildren(); status.textContent = 'Searching…';
    try {
      const res = await fetch(`/api/search?${new URLSearchParams({ q: input.value.trim(), type: type.value })}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`Search unavailable (HTTP ${res.status})`);
      const data = await res.json() as SearchResponse;
      if (mine !== revision) return;
      status.textContent = `${data.type === 'hybrid' ? data.reranked ? 'Hybrid · reranked by Voyage' : 'Hybrid · reranking unavailable' : 'Atlas place search'} · ${data.hits.length} results`;
      for (const [index, hit] of data.hits.entries()) {
        const row = document.createElement('li'), title = document.createElement('strong'), text = document.createElement('p');
        title.textContent = hit.title; text.textContent = hit.snippet ?? '';
        row.append(title, text);
        if (hit.rankBeforeRerank != null && data.reranked) { const rank = document.createElement('small'); rank.textContent = `Rank ${hit.rankBeforeRerank} → ${index + 1}`; row.append(rank); }
        if (hit.lngLat) { const show = document.createElement('button'); show.type = 'button'; show.className = 'link'; show.textContent = 'Show on map'; show.onclick = () => flyTo(hit.lngLat!); row.append(show); }
        if (hit.sourceUrl) { try { const url = new URL(hit.sourceUrl); if (['https:', 'http:'].includes(url.protocol)) { const source = document.createElement('a'); source.href = url.href; source.target = '_blank'; source.rel = 'noopener noreferrer'; source.textContent = 'Source'; row.append(source); } } catch { /* Invalid source URL is omitted. */ } }
        results.append(row);
      }
    } catch (err) { if (mine === revision) status.textContent = err instanceof Error ? err.message : String(err); }
    finally { clearTimeout(timeout); if (mine === revision) button.disabled = !enabled; }
  });
  return { setEnabled(value: boolean) { enabled = value; input.disabled = type.disabled = button.disabled = !value; if (!value) { revision++; controller?.abort(); results.replaceChildren(); status.textContent = 'Connect to the live API to search places and knowledge.'; } else status.textContent = ''; } };
}
