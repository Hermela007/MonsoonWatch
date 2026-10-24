// C7 search, callable in-process (B's agent tools) or via GET /api/search and /api/knowledge/:id/similar.
// Every call writes its Tech HUD step(s) to agent_steps (pass `runId` to attach them to an agent run).
export { searchPlaces, type PlaceSearchResult, type SearchPlacesOptions } from "./places";
export {
  searchKnowledge, similarKnowledge, FUSED_LIMIT, RERANK_MODEL,
  type KnowledgeSearchResult, type SearchKnowledgeOptions, type SimilarKnowledgeResult,
} from "./knowledge";
