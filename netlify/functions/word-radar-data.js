// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');
const { getStore } = require('@netlify/blobs');
const { createHash } = require('crypto');

function generateCacheKey(object, prompt) {
    const ordered = Object.keys(object)
        .sort()
        .reduce((obj, key) => {
            obj[key] = object[key];
            return obj;
        }, {});
    const str = JSON.stringify(ordered) + prompt;
    return createHash('sha256').update(str).digest('hex');
}

// PROMPT FOR STANDARD SYNONYM RADAR (MODIFIED)
function getLLMPrompt(word, partOfSpeech, category, synonyms) {
    const systemPrompt = `You are a linguist creating a Word Radar visualization dataset. You will be given a hub word, a part of speech, and a list of related words. Your task is to filter and classify these words.

REQUIREMENTS:
1.  **FILTER FIRST:** From the provided "Synonyms" list, you MUST select ONLY the words and phrasal verbs that function as a **${partOfSpeech}**. Discard any that do not fit this grammatical role.
2.  Create **2-3 semantic facets** (axes) for the hub word. DO NOT create a gradable opposites/antonym scale (a cline), as that is handled separately.
3.  If a Focus Category is provided, one facet MUST relate to it.
4.  For each word from your **filtered, grammatically-correct list**, generate: facet index (starting from 0 for your facets), ring (0-3), frequency (0-100), a brief definition, a natural usage example, a difficulty rating ('beginner', 'intermediate', or 'advanced'), and intensity scores for all facets.
5.  Ensure the classified words are distributed logically across ALL your facets. Do not assign all words to just one facet.

JSON Structure:
{
  "hub_word": "original word",
  "part_of_speech": "provided part of speech", 
  "facets": [
    {"name": "Semantic Dimension", "key": "dimension_key", "spectrumLabels": ["Low End", "High End"]}
  ],
  "rings": ["Core", "Common", "Specific", "Nuanced"],
  "words": [
    {
      "term": "synonym_from_filtered_list",
      "facet": 0,
      "ring": 1,
      "frequency": 65,
      "definition": "Brief, clear definition for this specific synonym.",
      "example": "Natural usage example for the synonym.",
      "difficulty": "intermediate",
      "intensities": {"dimension_key": 0.5, "other_key": -0.3}
    }
  ]
}

Return ONLY valid JSON.`;

    let userPrompt = `Hub Word: "${word}"\nPart of Speech: "${partOfSpeech}"\n\nSynonyms to filter and classify:\n[${synonyms.map(s => `"${s}"`).join(', ')}]`;
    
    if (category) {
        userPrompt += `\n\nFocus Category: "${category}"`;
    }
    
    return { systemPrompt, userPrompt };
}

// NEW PROMPT FOR CLINE GENERATION
function getLLMClinePrompt(word, partOfSpeech) {
    const systemPrompt = `You are a linguist creating a dataset for a "Cline" visualization, which is a scale of gradable words from one extreme to its opposite.

TASK:
For the given hub word, generate a list of 8-12 words that form a continuous scale from its most extreme gradable antonym to the hub word itself and slightly beyond if applicable. For example, for "hot", the scale could be (freezing, cold, cool, mild, warm, hot, scorching).

REQUIREMENTS:
1.  The list MUST include the hub word and at least one strong antonym.
2.  All words must be grammatically correct as a **${partOfSpeech}**.
3.  For EACH word in the cline, provide:
    *   **term**: The word itself.
    *   **intensity**: A numeric score from -1.0 (most extreme antonym) to 1.0 (most extreme synonym/hub word), with neutral/middle words around 0.
    *   **definition**: A brief, clear definition.
    *   **example**: A natural sentence using the word.
    *   **difficulty**: 'beginner', 'intermediate', or 'advanced'.
    *   **frequency**: An estimated usage frequency from 0 to 100.
4.  Identify the two extremes of your generated scale and provide them as `spectrumLabels`.

JSON Structure:
{
  "hub_word": "${word}",
  "part_of_speech": "${partOfSpeech}",
  "spectrumLabels": ["Extreme Antonym", "Extreme Synonym"],
  "words": [
    {
      "term": "antonym",
      "intensity": -1.0,
      "definition": "...",
      "example": "...",
      "difficulty": "beginner",
      "frequency": 80
    },
    {
      "term": "middle_word",
      "intensity": 0.0,
      "definition": "...",
      "example": "...",
      "difficulty": "intermediate",
      "frequency": 50
    },
    {
      "term": "${word}",
      "intensity": 0.8,
      "definition": "...",
      "example": "...",
      "difficulty": "beginner",
      "frequency": 90
    }
  ]
}

Return ONLY valid JSON.`;

    const userPrompt = `Generate a cline for:\nHub Word: "${word}"\nPart of Speech: "${partOfSpeech}"`;
    
    return { systemPrompt, userPrompt };
}

async function getCachedResponse(requestBody, promptFunction, store) {
    const { systemPrompt, userPrompt } = promptFunction(requestBody.word, requestBody.partOfSpeech, requestBody.category, requestBody.synonyms);
    // Add requestType to cache key to differentiate between 'radar' and 'cline' requests for the same word
    const cacheKeyObject = { ...requestBody };
    delete cacheKeyObject.synonyms; // Don't include synonyms list in key for cline
    const cacheKey = generateCacheKey(cacheKeyObject, systemPrompt);
    
    try {
        const cachedData = await store.get(cacheKey, { type: "json" });
        if (cachedData) {
            console.log(`CACHE HIT for key: ${cacheKey}`);
            return cachedData;
        }
    } catch (error) {
        console.warn(`Cache read failed for key ${cacheKey}:`, error.message);
    }

    console.log(`CACHE MISS for key: ${cacheKey}. Calling LLM...`);
    const apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
    
    try {
        await store.setJSON(cacheKey, apiResponse);
        console.log(`Stored new response in cache for key: ${cacheKey}`);
    } catch (error) {
        console.warn(`Cache write failed for key ${cacheKey}:`, error.message);
    }
    
    return apiResponse;
}

// --- All other helper functions like processSensesWithClustering, callOpenRouterWithFallback, etc., remain unchanged ---

// [Keep the existing processSensesWithClustering and callOpenRouterWithFallback functions here]
function cleanDefinition(definition) {
    return definition
        .replace(/{.*?}/g, '')      // Remove markup like {it}
        .replace(/\s+/g, ' ')       // Normalize whitespace
        .replace(/^:\s*/, '')       // Remove leading colons
        .replace(/[;,].*$/, '')     // Keep only the first clause before a semicolon or comma
        .trim()
        .toLowerCase();
}

function calculateSimilarity(str1, str2) {
    // Jaccard similarity based on word tokens
    const words1 = new Set(str1.split(/\s+/));
    const words2 = new Set(str2.split(/\s+/));
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

function processSensesWithClustering(
    allRawSenses, 
    primarySenseCount = 3, 
    maxTotalSenses = 8, 
    similarityThreshold = 0.5
) {
    // 1. Pre-process and pre-sort by synonym count to establish cluster seeds
    const processedSenses = allRawSenses
        .map(sense => ({
            ...sense,
            cleanDef: cleanDefinition(sense.definition),
            synonymCount: sense.synonyms.length
        }))
        .sort((a, b) => b.synonymCount - a.synonymCount);

    // 2. Greedily cluster similar senses
    const clusters = [];
    for (const sense of processedSenses) {
        if (sense.synonymCount === 0) continue;

        let foundCluster = false;
        for (const cluster of clusters) {
            if (calculateSimilarity(sense.cleanDef, cluster.cleanDef) > similarityThreshold) {
                // Merge into the existing cluster
                const combinedSynonyms = new Set([...cluster.synonyms, ...sense.synonyms]);
                cluster.synonyms = Array.from(combinedSynonyms);
                cluster.synonymCount = cluster.synonyms.length;

                // Keep the longer, likely more descriptive, definition as the representative
                if (sense.definition.length > cluster.definition.length) {
                    cluster.definition = sense.definition;
                    cluster.cleanDef = sense.cleanDef;
                }
                foundCluster = true;
                break;
            }
        }

        if (!foundCluster) {
            // No similar cluster found, create a new one
            clusters.push({ ...sense });
        }
    }

    // 3. Sort final clusters by their aggregated synonym count
    const finalSenses = clusters.sort((a, b) => b.synonymCount - a.synonymCount);

    // 4. Split into primary and additional for progressive disclosure
    if (finalSenses.length === 0) return { senses: [], hasMore: false };
    if (finalSenses.length <= primarySenseCount) return { senses: finalSenses, hasMore: false };

    const primarySenses = finalSenses.slice(0, primarySenseCount);
    const additionalSenses = finalSenses.slice(primarySenseCount, maxTotalSenses);

    return {
        senses: primarySenses,
        additionalSenses: additionalSenses.length > 0 ? additionalSenses : null,
        hasMore: additionalSenses.length > 0
    };
}


async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key is not configured.');
    const modelsToTry = [ "openrouter/sonoma-sky-alpha", "openrouter/sonoma-dusk-alpha", "mistralai/mistral-small-3.2-24b-instruct:free", "openai/gpt-oss-120b:free", "google/gemini-flash-1.5-8b" ];
    for (const model of modelsToTry) {
        console.log(`Attempting API call with model: ${model}`);
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: model, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] })
            });
            if (!response.ok) { const errorBody = await response.text(); console.warn(`Model '${model}' failed with status ${response.status}: ${errorBody}`); continue; }
            const data = await response.json();
            if (data.choices && data.choices[0] && data.choices[0].message?.content) {
                console.log(`Successfully received response from: ${model}`);
                try { return JSON.parse(data.choices[0].message.content); } catch (parseError) { console.warn(`Model '${model}' returned unparseable JSON. Trying next model.`); continue; }
            } else { console.warn(`Model '${model}' returned no choices. Trying next model.`); }
        } catch (error) { console.error(`An unexpected network error occurred with model '${model}':`, error); }
    }
    throw new Error("All AI models failed to provide a valid response. Please try again later.");
}
exports.handler = async (event, context) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        const body = JSON.parse(event.body || '{}');
        const { word, partOfSpeech, category, synonyms, requestType } = body;
        
        if (!word || !partOfSpeech) return { statusCode: 400, headers, body: JSON.stringify({ error: "Word and Part of Speech are required." }) };
        
        let store;
        try { store = getStore("word-radar-cache"); } catch (storeError) { console.warn('Failed to initialize blob store:', storeError.message); store = null; }

        // --- ROUTE TO CLINE GENERATION ---
        if (requestType === 'cline') {
            console.log(`Received cline request for "${word}".`);
            const promptFunction = getLLMClinePrompt;
            const apiResponse = store ? 
                await getCachedResponse({ word, partOfSpeech, requestType }, promptFunction, store) :
                await (async () => {
                    const { systemPrompt, userPrompt } = promptFunction(word, partOfSpeech);
                    return await callOpenRouterWithFallback(systemPrompt, userPrompt);
                })();
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        // --- EXISTING RADAR/SYNONYM FLOW ---
        if (synonyms && synonyms.length > 0) {
            const apiResponse = await getCachedResponse({ word, partOfSpeech, category, synonyms }, getLLMPrompt, store);
            apiResponse.hub_word = word; apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        // --- [The rest of the thesaurus lookup and sense processing logic remains exactly the same] ---
        const MW_API_KEY = process.env.MW_THESAURUS_API_KEY;
        if (!MW_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Merriam-Webster API key is not configured.' }) };

        const url = `https://www.dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${MW_API_KEY}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`MW API request failed: ${response.status}`);
        
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== 'object') {
            return { statusCode: 404, headers, body: JSON.stringify({ error: `No entries found for "${word}".` }) };
        }
        
        const allRawSenses = data
            .filter(entry => entry.fl === partOfSpeech)
            .flatMap(entry => {
                if (!entry.def || !entry.def[0] || !entry.def[0].sseq) return [];
                return entry.def[0].sseq.map(sense_block => {
                    const sense_data = sense_block[0][1];
                    let definition = (sense_data.dt && sense_data.dt[0] && sense_data.dt[0][1]) || sense_data.shortdef?.[0] || 'General sense';
                    const synonyms = (sense_data.syn_list || []).flatMap(syn_group => syn_group.map(syn => syn.wd)).slice(0, 25);
                    return { definition, synonyms };
                });
            });

        const processedSenses = processSensesWithClustering(allRawSenses);
        
        if (processedSenses.senses.length === 0) {
            return { statusCode: 404, headers, body: JSON.stringify({ 
                error: `No synonyms found for "${word}" as a ${partOfSpeech}.` 
            }) };
        }

        if (processedSenses.senses.length === 1 && !processedSenses.hasMore) {
            console.log(`Single sense found for "${word}", proceeding directly to generation.`);
            const apiResponse = await getCachedResponse({ word, partOfSpeech, category, synonyms: processedSenses.senses[0].synonyms }, getLLMPrompt, store);
            apiResponse.hub_word = word; 
            apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        console.log(`Multiple consolidated senses found for "${word}" (${processedSenses.senses.length} primary, ${processedSenses.additionalSenses?.length || 0} additional), returning for user selection.`);
        return { statusCode: 200, headers, body: JSON.stringify({
            senses: processedSenses.senses,
            additionalSenses: processedSenses.additionalSenses,
            hasMore: processedSenses.hasMore
        }) };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Server error: ${error.message}` }) };
    }
};