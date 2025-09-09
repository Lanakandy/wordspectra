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

function getLLMPrompt(word, partOfSpeech, category, synonyms) {
    const systemPrompt = `You are a linguist creating a Word Radar visualization dataset. You will be given a hub word, a part of speech, and a list of related words. Your task is to filter, find opposites, and classify these words.

REQUIREMENTS:
1.  **IDENTIFY OPPOSITE:** First, determine if the hub word is gradable (like 'hot', 'big', 'fast'). If it is, identify its primary antonym (e.g., for 'hot', the antonym is 'cold').
2.  **CREATE POLARITY FACET:** If an antonym is found, one of the 3-4 semantic facets MUST be a "polarity" axis representing the cline between the antonym and the hub word. Name it appropriately (e.g., "Temperature") and set its spectrumLabels to be the antonym and the hub word (e.g., ["Cold", "Hot"]).
3.  **GATHER WORDS:** The list of words to classify should now include BOTH the provided synonyms AND a few relevant antonyms for the identified opposite.
4.  **FILTER GRAMMAR:** From this combined list, you MUST select ONLY the words and phrasal verbs that function as a **${partOfSpeech}**.
5.  **CLASSIFY & SCORE:** For each word from your **filtered list**, generate all required fields. For the polarity facet, assign an intensity score from -1.0 (strongest antonym) to +1.0 (strongest synonym). A word like 'tepid' might be near 0.0.
6.  **DISTRIBUTE:** Ensure the classified words are distributed logically across ALL facets.

JSON Structure (no changes needed):
{
  "hub_word": "original word",
  "part_of_speech": "provided part of speech", 
  "facets": [
    {"name": "Temperature", "key": "temperature", "spectrumLabels": ["Cold", "Hot"]}
    // ... other facets
  ],
  "rings": ["Core", "Common", "Specific", "Nuanced"],
  "words": [
    // A synonym
    { "term": "scorching", "facet": 0, "ring": 2, ..., "intensities": {"temperature": 0.9, ...} },
    // An antonym
    { "term": "freezing", "facet": 0, "ring": 2, ..., "intensities": {"temperature": -0.9, ...} }
  ]
}

Return ONLY valid JSON.`;
// ... User prompt remains the same, the LLM will source antonyms itself.
    let userPrompt = `Hub Word: "${word}"\nPart of Speech: "${partOfSpeech}"\n\nSynonyms to filter and classify:\n[${synonyms.map(s => `"${s}"`).join(', ')}]`;
    
    if (category) {
        userPrompt += `\n\nFocus Category: "${category}"`;
    }
    
    return { systemPrompt, userPrompt };
}

// --- NEW ENHANCED SENSE PROCESSING LOGIC ---

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

async function getCachedLlmResponse({ word, partOfSpeech, category, synonyms }, store) {
    const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, synonyms);
    const cacheKey = generateCacheKey({ word, partOfSpeech, category, synonyms }, systemPrompt);
    
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

exports.handler = async (event, context) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        const body = JSON.parse(event.body || '{}');
        const { word, partOfSpeech, category, synonyms } = body;
        
        if (!word || !partOfSpeech) return { statusCode: 400, headers, body: JSON.stringify({ error: "Word and Part of Speech are required." }) };
        
        let store;
        try { store = getStore("word-radar-cache"); } catch (storeError) { console.warn('Failed to initialize blob store:', storeError.message); store = null; }
        
        if (synonyms && synonyms.length > 0) {
            const apiResponse = store ? await getCachedLlmResponse({ word, partOfSpeech, category, synonyms }, store) : await (async () => {
                const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, synonyms);
                return await callOpenRouterWithFallback(systemPrompt, userPrompt);
            })();
            apiResponse.hub_word = word; apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

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

        // *** DROP-IN REPLACEMENT: Use the new clustering function ***
        const processedSenses = processSensesWithClustering(allRawSenses);
        
        if (processedSenses.senses.length === 0) {
            return { statusCode: 404, headers, body: JSON.stringify({ 
                error: `No synonyms found for "${word}" as a ${partOfSpeech}.` 
            }) };
        }

        if (processedSenses.senses.length === 1 && !processedSenses.hasMore) {
            console.log(`Single sense found for "${word}", proceeding directly to generation.`);
            const apiResponse = store ? 
                await getCachedLlmResponse({ word, partOfSpeech, category, synonyms: processedSenses.senses[0].synonyms }, store) : 
                await (async () => {
                    const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, processedSenses.senses[0].synonyms);
                    return await callOpenRouterWithFallback(systemPrompt, userPrompt);
                })();
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