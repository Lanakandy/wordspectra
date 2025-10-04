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
    return createHash('sha224').update(str).digest('hex');
}

function getLLMPrompt(word, partOfSpeech, synonyms) {
    const systemPrompt = `You are a linguist creating a Word Radar visualization dataset for language learners. You will be given a hub word, a part of speech, and a list of related words.

REQUIREMENTS:
1.  **FILTER SYNONYMS:** From the provided "Synonyms" list, select ONLY the words and phrasal verbs that function as a **${partOfSpeech}**. Discard any that do not fit this grammatical role.
2.  **GENERATE ANTONYMS:** Provide a list of 3-5 distinct antonyms (opposites) for the hub word in its role as a ${partOfSpeech}.
3.  **CLASSIFY FILTERED SYNONYMS:** For each word from your filtered list, generate the required data points.
    *   **formality:** Score from -1.0 (very informal, slang) to 1.0 (very formal, academic). 0.0 is neutral.
    *   **style:** Score from -1.0 (literal, denotative) to 1.0 (figurative, expressive, connotative). 0.0 is neutral.
    *   **ring:** A categorical distance from the hub word's core meaning (0: Core, 1: Common, 2: Specific, 3: Nuanced).
    *   **frequency:** A score from 0 (very rare) to 100 (very common).
    *   **definition:** A brief, clear definition.
    *   **example:** A natural usage example.
    *   **difficulty:** 'beginner', 'intermediate', or 'advanced'.

JSON Structure:
{
  "hub_word": "original word",
  "part_of_speech": "provided part of speech",
  "rings": ["Core", "Common", "Specific", "Nuanced"],
  "antonyms": ["opposite1", "opposite2", "opposite3"],
  "words": [
    {
      "term": "synonym_from_filtered_list",
      "ring": 1,
      "frequency": 75,
      "formality": -0.3,
      "style": 0.8,
      "definition": "Brief, clear definition for this specific synonym.",
      "example": "Natural usage example for the synonym.",
      "difficulty": "intermediate"
    }
  ]
}`;

    let userPrompt = `Hub Word: "${word}"\nPart of Speech: "${partOfSpeech}"\n\nSynonyms to filter and classify:\n[${synonyms.map(s => `"${s}"`).join(', ')}]`;
    
    return { systemPrompt, userPrompt };
}

function getAntonymSpectrumPrompt(startWord, endWord) {
    const systemPrompt = `You are a linguist creating a dataset for a word spectrum (cline) visualization. You will be given two words that represent opposite ends of a semantic spectrum.

REQUIREMENTS:
1. **GENERATE SPECTRUM:** Generate 8-12 intermediate words that form a smooth semantic gradient between the start_word and end_word. Words should progress gradually with no sudden jumps in meaning.
2.  **INCLUDE ENDPOINTS:** The final list of words MUST begin with the \`start_word\` and end with the \`end_word\`.
3.  **PROVIDE DATA:** For EACH word in the full list (including start and end), provide the following data points:
    *   **term**: The word itself.
    *   **spectrum_position**: A score from -1.0 (start_word) to 1.0 (end_word). 
        - Distribute positions to reflect semantic distance, not just equal intervals
        - Words closer in meaning should have closer position scores
        - The start_word is always -1.0, the end_word is always 1.0
    *   **formality**: Score from -1.0 (slang/colloquial, e.g., "yummy") through 0.0 (neutral, e.g., "good") to 1.0 (formal/technical, e.g., "efficacious").
    *   **definition**: A brief, clear definition.
    *   **example**: A natural usage example.
    *   **frequency**: Score from 0-100 based on everyday usage:
        - 80-100: Very common (e.g., "good", "bad", "happy")
        - 50-79: Common (e.g., "adequate", "pleasant")
        - 20-49: Uncommon (e.g., "felicitous", "mediocre")
        - 0-19: Rare (e.g., "pusillanimous", "ebullient")
    *   **difficulty**: 'beginner', 'intermediate', or 'advanced'.

JSON Structure:
{
  "start_word": "The original start word",
  "end_word": "The original end word",
  "words": [
    {
      "term": "start_word",
      "spectrum_position": -1.0, "formality": 0.2, "definition": "...", "example": "...", "frequency": 60, "difficulty": "intermediate"
    },
    // ... more intermediate words ...
    {
      "term": "end_word",
      "spectrum_position": 1.0, "formality": -0.1, "definition": "...", "example": "...", "frequency": 65, "difficulty": "intermediate"
    }
  ]
}

Return ONLY valid JSON.`;

    const userPrompt = `Start Word: "${startWord}"\nEnd Word: "${endWord}"`;
    return { systemPrompt, userPrompt };
}

// NEW: Prompt for fetching a single word's data in the context of a spectrum
function getSingleWordDataPrompt(wordToAdd, startWord, endWord) {
    const systemPrompt = `You are a linguist adding a word to an existing word spectrum (cline). You will be given a word to add, plus the start and end words of the spectrum for context.

REQUIREMENTS:
1.  **ANALYZE CONTEXT:** Analyze the semantic gradient between the \`start_word\` and \`end_word\`.
2.  **PROVIDE DATA FOR THE NEW WORD:** For the \`word_to_add\`, provide the following data points:
    *   **term**: The word itself.
    *   **spectrum_position**: A score from -1.0 (meaning it's very similar to the \`start_word\`) to 1.0 (very similar to the \`end_word\`). Estimate its position on this specific spectrum.
    *   **formality**: Score from -1.0 (very informal) to 1.0 (very formal). 0.0 is neutral.
    *   **definition**: A brief, clear definition.
    *   **example**: A natural usage example.
    *   **frequency**: A score from 0 (very rare) to 100 (very common).
    *   **difficulty**: 'beginner', 'intermediate', or 'advanced'.

JSON Structure (Return only a single JSON object for the word, not an array):
{
  "term": "word_to_add",
  "spectrum_position": 0.3,
  "formality": 0.5,
  "definition": "...",
  "example": "...",
  "frequency": 50,
  "difficulty": "intermediate"
}

Return ONLY valid JSON.`;

    const userPrompt = `Word to Add: "${wordToAdd}"\nSpectrum Start Word: "${startWord}"\nSpectrum End Word: "${endWord}"`;
    return { systemPrompt, userPrompt };
}

function cleanDefinition(definition) {
    return definition.replace(/{.*?}/g, '').replace(/\s+/g, ' ').replace(/^:\s*/, '').replace(/[;,].*$/, '').trim().toLowerCase();
}

function calculateSimilarity(str1, str2) {
    const words1 = new Set(str1.split(/\s+/)); const words2 = new Set(str2.split(/\s+/)); const intersection = new Set([...words1].filter(x => words2.has(x))); const union = new Set([...words1, ...words2]); return union.size === 0 ? 0 : intersection.size / union.size;
}

function processSensesWithClustering( allRawSenses, primarySenseCount = 3, maxTotalSenses = 8, similarityThreshold = 0.5 ) {
    const processedSenses = allRawSenses.map(sense => ({ ...sense, cleanDef: cleanDefinition(sense.definition), synonymCount: sense.synonyms.length })).sort((a, b) => b.synonymCount - a.synonymCount); const clusters = []; for (const sense of processedSenses) { if (sense.synonymCount === 0) continue; let foundCluster = false; for (const cluster of clusters) { if (calculateSimilarity(sense.cleanDef, cluster.cleanDef) > similarityThreshold) { const combinedSynonyms = new Set([...cluster.synonyms, ...sense.synonyms]); cluster.synonyms = Array.from(combinedSynonyms); cluster.synonymCount = cluster.synonyms.length; if (sense.definition.length > cluster.definition.length) { cluster.definition = sense.definition; cluster.cleanDef = sense.cleanDef; } foundCluster = true; break; } } if (!foundCluster) { clusters.push({ ...sense }); } } const finalSenses = clusters.sort((a, b) => b.synonymCount - a.synonymCount); if (finalSenses.length === 0) return { senses: [], hasMore: false }; if (finalSenses.length <= primarySenseCount) return { senses: finalSenses, hasMore: false }; const primarySenses = finalSenses.slice(0, primarySenseCount); const additionalSenses = finalSenses.slice(primarySenseCount, maxTotalSenses); return { senses: primarySenses, additionalSenses: additionalSenses.length > 0 ? additionalSenses : null, hasMore: additionalSenses.length > 0 };
}

async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key is not configured.'); const modelsToTry = [ "mistralai/mistral-7b-instruct:free", "openai/gpt-3.5-turbo-1106", "google/gemini-flash-1.5" ]; for (const model of modelsToTry) { console.log(`Attempting API call with model: ${model}`); try { const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] }) }); if (!response.ok) { const errorBody = await response.text(); console.warn(`Model '${model}' failed with status ${response.status}: ${errorBody}`); continue; } const data = await response.json(); if (data.choices && data.choices[0] && data.choices[0].message?.content) { console.log(`Successfully received response from: ${model}`); try { return JSON.parse(data.choices[0].message.content); } catch (parseError) { console.warn(`Model '${model}' returned unparseable JSON. Trying next model.`); continue; } } else { console.warn(`Model '${model}' returned no choices. Trying next model.`); } } catch (error) { console.error(`An unexpected network error occurred with model '${model}':`, error); } } throw new Error("All AI models failed to provide a valid response. Please try again later.");
}

// MODIFIED: This function can now handle 'singleWord' type
async function getCachedLlmResponse(payload, store, type = 'radar') {
    let systemPrompt, userPrompt, cacheKeyPayload;
    if (type === 'spectrum') {
        ({ systemPrompt, userPrompt } = getAntonymSpectrumPrompt(payload.word, payload.antonym));
        cacheKeyPayload = { word: payload.word, antonym: payload.antonym };
    } else if (type === 'singleWord') {
        ({ systemPrompt, userPrompt } = getSingleWordDataPrompt(payload.wordToAdd, payload.start_word, payload.end_word));
        cacheKeyPayload = { wordToAdd: payload.wordToAdd, start: payload.start_word, end: payload.end_word };
    } else { // 'radar'
        ({ systemPrompt, userPrompt } = getLLMPrompt(payload.word, payload.partOfSpeech, payload.synonyms));
        cacheKeyPayload = { word: payload.word, partOfSpeech: payload.partOfSpeech, synonyms: payload.synonyms };
    }
    const cacheKey = generateCacheKey(cacheKeyPayload, systemPrompt);

    try { const cachedData = await store.get(cacheKey, { type: "json" }); if (cachedData) { console.log(`CACHE HIT for key: ${cacheKey}`); return cachedData; } } catch (error) { console.warn(`Cache read failed for key ${cacheKey}:`, error.message); }

    console.log(`CACHE MISS for key: ${cacheKey}. Calling LLM...`);
    const apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
    
    try { await store.setJSON(cacheKey, apiResponse); console.log(`Stored new response in cache for key: ${cacheKey}`); } catch (error) { console.warn(`Cache write failed for key ${cacheKey}:`, error.message); }
    
    return apiResponse;
}

exports.handler = async (event, context) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

    try {
        const body = JSON.parse(event.body || '{}');
        const { word, partOfSpeech, synonyms, antonym, wordToAdd, start_word, end_word } = body;
        
        let store;
        try { store = getStore("word-radar-cache"); } catch (storeError) { console.warn('Failed to initialize blob store:', storeError.message); store = null; }

        // NEW: Handle request to add a single word to a spectrum
        if (wordToAdd && start_word && end_word) {
            console.log(`Fetching data for single word "${wordToAdd}" in spectrum "${start_word}" -> "${end_word}"`);
            const apiResponse = store ?
                await getCachedLlmResponse({ wordToAdd, start_word, end_word }, store, 'singleWord') :
                await (async () => {
                    const { systemPrompt, userPrompt } = getSingleWordDataPrompt(wordToAdd, start_word, end_word);
                    return await callOpenRouterWithFallback(systemPrompt, userPrompt);
                })();
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        if (word && antonym) {
            console.log(`Generating antonym spectrum for "${word}" vs "${antonym}"`);
            const apiResponse = store ?
                await getCachedLlmResponse({ word, antonym }, store, 'spectrum') :
                await (async () => {
                    const { systemPrompt, userPrompt } = getAntonymSpectrumPrompt(word, antonym);
                    return await callOpenRouterWithFallback(systemPrompt, userPrompt);
                })();
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }
        
        if (!word || !partOfSpeech) return { statusCode: 400, headers, body: JSON.stringify({ error: "Word and Part of Speech are required." }) };
        
        if (synonyms && synonyms.length > 0) {
            const apiResponse = store ? await getCachedLlmResponse({ word, partOfSpeech, synonyms }, store, 'radar') : await (async () => { const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, synonyms); return await callOpenRouterWithFallback(systemPrompt, userPrompt); })();
            apiResponse.hub_word = word; apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        const MW_API_KEY = process.env.MW_THESAURUS_API_KEY;
        if (!MW_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Merriam-Webster API key is not configured.' }) };

        const url = `https://www.dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${MW_API_KEY}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`MW API request failed: ${response.status}`);
        
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== 'object') { return { statusCode: 404, headers, body: JSON.stringify({ error: `No entries found for "${word}".` }) }; }
        
        const allRawSenses = data.filter(entry => entry.fl === partOfSpeech).flatMap(entry => { if (!entry.def || !entry.def[0] || !entry.def[0].sseq) return []; return entry.def[0].sseq.map(sense_block => { const sense_data = sense_block[0][1]; let definition = (sense_data.dt && sense_data.dt[0] && sense_data.dt[0][1]) || sense_data.shortdef?.[0] || 'General sense'; const synonyms = (sense_data.syn_list || []).flatMap(syn_group => syn_group.map(syn => syn.wd)).slice(0, 25); return { definition, synonyms }; }); });
        
        const processedSenses = processSensesWithClustering(allRawSenses);
        
        if (processedSenses.senses.length === 0) { return { statusCode: 404, headers, body: JSON.stringify({ error: `No synonyms found for "${word}" as a ${partOfSpeech}.` }) }; }

        if (processedSenses.senses.length === 1 && !processedSenses.hasMore) {
            console.log(`Single sense found for "${word}", proceeding directly to generation.`);
            const apiResponse = store ? await getCachedLlmResponse({ word, partOfSpeech, synonyms: processedSenses.senses[0].synonyms }, store, 'radar') : await (async () => { const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, processedSenses.senses[0].synonyms); return await callOpenRouterWithFallback(systemPrompt, userPrompt); })();
            apiResponse.hub_word = word; apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        console.log(`Multiple consolidated senses found for "${word}" (${processedSenses.senses.length} primary, ${processedSenses.additionalSenses?.length || 0} additional), returning for user selection.`);
        return { statusCode: 200, headers, body: JSON.stringify({ senses: processedSenses.senses, additionalSenses: processedSenses.additionalSenses, hasMore: processedSenses.hasMore }) };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Server error: ${error.message}` }) };
    }
};