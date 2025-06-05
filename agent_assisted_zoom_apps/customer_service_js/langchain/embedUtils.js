import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { FakeEmbeddings } from 'langchain/embeddings/fake';

export async function splitDocuments(docs) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 150,
  });

  const allChunks = [];

  for (const { file, content } of docs) {
    const chunks = await splitter.createDocuments([content], {
      metadata: { source: file },
    });

    allChunks.push(...chunks);
  }

  return allChunks;
}

export async function createRetriever(chunks, topK = 5) {
  const embeddings = new FakeEmbeddings(); // ✅ always works

  const vectorStore = await MemoryVectorStore.fromDocuments(chunks, embeddings);
  return vectorStore.asRetriever(topK);
}
