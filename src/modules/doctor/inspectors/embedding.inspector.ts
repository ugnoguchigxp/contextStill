import { embeddingHealth } from "../../embedding/embedding.service.js";

export async function inspectEmbedding() {
  return embeddingHealth();
}
