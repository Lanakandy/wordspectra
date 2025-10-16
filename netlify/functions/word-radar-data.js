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
    // MODIFIED PROMPT: Now asks for two orthogonal facets (facetX, facetY) instead of one facet and formality.
    const systemPrompt = `You are an expert linguist creating a dynamic Word Radar dataset for language learners. Your primary task is to identify TWO meaningful, largely orthogonal semantic spectrums for a given set of synonyms and then classify each word along both spectrums.

**MAIN TASK:**

1.  **Analyze Synonyms:** Review the provided list of all synonyms for the hub word "${word}".
2.  **Define TWO Semantic Facets:** Based on the synonyms, choose the two most important semantic spectrums that highlight their nuances.
    *   **Primary Facet (X-axis):** This should be the most obvious or significant difference. For "scary", it might be **Intensity**.
    *   **Secondary Facet (Y-axis):** This should be a different, interesting dimension clear for a language learner. For "scary", it might be the **Nature of Fear** (e.g., "Psychological" vs. "Supernatural").
3.  **Provide Facet Data:** Structure this information in \`facetX\` and \`facetY\` objects, each with:
    *   \`key\`: A single, lowercase programmatic key (e.g., "intensity", "nature_of_fear").
    *   \`spectrumLabels\`: An array of two strings for the ends of the spectrum, corresponding to scores of -1.0 and 1.0 respectively (e.g., ["Subtle", "Forceful"], ["Psychological", "Supernatural"]).
4.  **Classify Words:** For each synonym, provide its data, using the keys you defined.
    *   **[your_facetX_key]:** A score from -1.0 to 1.0 along the primary spectrum.
    *   **[your_facetY_key]:** A score from -1.0 to 1.0 along the secondary spectrum.
5.  **Generate Antonyms:** Provide 3-5 distinct antonyms for the hub word.

**JSON STRUCTURE:**
{
  "hub_word": "original word",
  "part_of_speech": "provided part of speech",
  "facetX": {
    "key": "intensity",
    "spectrumLabels": ["Unsettling Dread", "Overwhelming Terror"]
  },
  "facetY": {
    "key": "source_of_fear",
    "spectrumLabels": ["Psychological/Internal", "Supernatural/External"]
  },
  "antonyms": ["comforting", "reassuring", "soothing"],
  "words": [
    {
      "term": "synonym_from_list",
      "frequency": 75,
      "intensity": 0.8,
      "source_of_fear": -0.4,
      "definition": "...",
      "example": "...",
      "difficulty": "intermediate"
    }
  ]
}`;

    let userPrompt = `Hub Word: "${word}"\nPart of Speech: "${partOfSpeech}"\n\nSynonyms to filter and classify:\n[${synonyms.map(s => `"${s}"`).join(', ')}]`;
    
    return { systemPrompt, userPrompt };
}

function getAntonymSpectrumPrompt(startWord, endWord) {
    const systemPrompt = `You are a linguist creating a dataset for a word spectrum (cline) visualization based on the CEFR framework for language learners.

REQUIREMENTS:
1.  **GENERATE SPECTRUM:** Generate 8-12 intermediate words that form a smooth semantic gradient between the start_word and end_word.
2.  **INCLUDE ENDPOINTS:** The final list MUST begin with the \`start_word\` and end with the \`end_word\`.
3.  **PROVIDE DATA:** For EACH word, provide the following data points:
    *   **term**: The word itself.
    *   **spectrum_position**: A score from -1.0 (start_word) to 1.0 (end_word), distributed to reflect semantic distance.
    *   **formality**: Score from -1.0 (informal) to 1.0 (formal).
    *   **definition**: A brief, clear definition.
    *   **example**: A natural usage example.
    *   **frequency**: Score from 0 (rare) to 100 (very common).
    *   **difficulty**: 'beginner', 'intermediate', or 'advanced'. **Crucially, this MUST be based on the CEFR framework, not just frequency.**
        - **beginner (A1-A2):** Core vocabulary for simple, everyday situations. (e.g., happy, big, good, walk)
        - **intermediate (B1-B2):** More descriptive, nuanced words for expressing opinions or discussing topics. (e.g., anxious, optimistic, confident, concerned)
        - **advanced (C1-C2):** Sophisticated, formal, or specialized words for academic or professional contexts. (e.g., apprehensive, ebullient, meticulous)

JSON Structure:
{
  "start_word": "The original start word",
  "end_word": "The original end word",
  "words": [
    {
      "term": "start_word", "spectrum_position": -1.0, "formality": 0.2, "definition": "...", "example": "...", "frequency": 60, "difficulty": "intermediate"
    },
    // ... more intermediate words ...
    {
      "term": "end_word", "spectrum_position": 1.0, "formality": -0.1, "definition": "...", "example": "...", "frequency": 65, "difficulty": "intermediate"
    }
  ]
}

Return ONLY valid JSON.`;

    const userPrompt = `Start Word: "${startWord}"\nEnd Word: "${endWord}"`;
    return { systemPrompt, userPrompt };
}

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
    *   **difficulty**: 'beginner', 'intermediate', or 'advanced'. **Crucially, this MUST be based on the CEFR framework, not just frequency.**
        - **beginner (A1-A2):** Core vocabulary for simple, everyday situations. (e.g., happy, big, good, walk)
        - **intermediate (B1-B2):** More descriptive, nuanced words for expressing opinions or discussing topics. (e.g., anxious, optimistic, confident, concerned)
        - **advanced (C1-C2):** Sophisticated, formal, or specialized words for academic or professional contexts. (e.g., apprehensive, ebullient, meticulous)

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

function processSensesWithClustering( allRawSenses, primarySenseCount = 3, maxTotalSenses = 8, similarityThreshold = 0.3 ) {
    const processedSenses = allRawSenses.map(sense => ({ ...sense, cleanDef: cleanDefinition(sense.definition), synonymCount: sense.synonyms.length })).sort((a, b) => b.synonymCount - a.synonymCount); const clusters = []; for (const sense of processedSenses) { if (sense.synonymCount === 0) continue; let foundCluster = false; for (const cluster of clusters) { if (calculateSimilarity(sense.cleanDef, cluster.cleanDef) > similarityThreshold) { const combinedSynonyms = new Set([...cluster.synonyms, ...sense.synonyms]); cluster.synonyms = Array.from(combinedSynonyms); cluster.synonymCount = cluster.synonyms.length; if (sense.definition.length > cluster.definition.length) { cluster.definition = sense.definition; cluster.cleanDef = sense.cleanDef; } foundCluster = true; break; } } if (!foundCluster) { clusters.push({ ...sense }); } } const finalSenses = clusters.sort((a, b) => b.synonymCount - a.synonymCount); if (finalSenses.length === 0) return { senses: [], hasMore: false }; if (finalSenses.length <= primarySenseCount) return { senses: finalSenses, hasMore: false }; const primarySenses = finalSenses.slice(0, primarySenseCount); const additionalSenses = finalSenses.slice(primarySenseCount, maxTotalSenses); return { senses: primarySenses, additionalSenses: additionalSenses.length > 0 ? additionalSenses : null, hasMore: additionalSenses.length > 0 };
}

async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY; if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key is not configured.'); 
    const modelsToTry = [ "microsoft/mai-ds-r1:free", "mistralai/mistral-small-3.2-24b-instruct:free", "mistralai/mistral-7b-instruct:free", "openai/gpt-oss-120b:free", "google/gemini-flash-1.5-8b" ]; 
    for (const model of modelsToTry) { console.log(`Attempting API call with model: ${model}`); try { const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: model, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] }) }); if (!response.ok) { const errorBody = await response.text(); console.warn(`Model '${model}' failed with status ${response.status}: ${errorBody}`); continue; } const data = await response.json(); if (data.choices && data.choices[0] && data.choices[0].message?.content) { console.log(`Successfully received response from: ${model}`); try { return JSON.parse(data.choices[0].message.content); } catch (parseError) { console.warn(`Model '${model}' returned unparseable JSON. Trying next model.`); continue; } } else { console.warn(`Model '${model}' returned no choices. Trying next model.`); } } catch (error) { console.error(`An unexpected network error occurred with model '${model}':`, error); } } throw new Error("All AI models failed to provide a valid response. Please try again later.");
}

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

        // FIX: This block for adding a single word MUST come first, as its payload is more specific.
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

        // This block now correctly handles only new spectrum requests.
        if ((start_word && end_word) || (word && antonym)) {
            const sWord = start_word || word;
            const eWord = end_word || antonym;

            console.log(`Generating spectrum for "${sWord}" vs "${eWord}"`);
            const apiResponse = store ?
                await getCachedLlmResponse({ word: sWord, antonym: eWord }, store, 'spectrum') :
                await (async () => {
                    const { systemPrompt, userPrompt } = getAntonymSpectrumPrompt(sWord, eWord);
                    return await callOpenRouterWithFallback(systemPrompt, userPrompt);
                })();
            
            apiResponse.start_word = sWord;
            apiResponse.end_word = eWord;
            
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }
        
        // --- RADAR VIEW LOGIC (Unchanged) ---
        if (!word || !partOfSpeech) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: "Word and Part of Speech are required." }) };
        }
        
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