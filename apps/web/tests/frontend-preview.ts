import { createKnowledgeSearch } from '../src/ui/knowledge';
import { createAlertAudio } from '../src/ui/alertAudio';
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (String(input).startsWith('/api/search')) {
    if ((document.getElementById('fail') as HTMLInputElement).checked) return new Response('', { status: 503 });
    const type = new URL(String(input), location.origin).searchParams.get('type');
    return Response.json({ type, query: 'flood', reranked: type === 'hybrid', hits: [{ id: 'test', title: '2014 response plan', snippet: '<script>untrusted content</script> Keep routes clear.', kind: 'knowledge', rankBeforeRerank: 4, score: .9, sourceUrl: 'javascript:alert(1)' }] });
  }
  return nativeFetch(input, init);
};
createKnowledgeSearch(document.getElementById('search')!, () => {}).setEnabled(true);
createAlertAudio(document.getElementById('audio')!).set({ id: 'preview-not-a-real-alert', languages: ['ms', 'en'] });
