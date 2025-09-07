// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');
const { getStore } = require('@netlify/blobs');
const { createHash } = require('crypto');

function generateCacheKey(object) {
    const ordered = Object.keys(object)
        .sort()
        .reduce((obj, key) => {
            obj[key] = object[key];
            return obj;
        }, {});
    const str = JSON.stringify(ordered);
    return createHash('sha256').update(str).digest('hex');
}

// --- MODIFIED SECTION: Improved LLM Prompt ---
function getLLMPrompt(word, partOfSpeech, category, synonyms) {
    // The prompt is updated to explicitly include phrasal verbs in the filtering step.
    const systemPrompt = `You are a linguist creating a Word Radar visualization dataset. You will be given a hub word, a part of speech, and a list of related words. Your task is to filter and classify these words.

REQUIREMENTS:
1.  **FILTER FIRST:** From the provided "Synonyms" list, you MUST select ONLY the words and phrasal verbs that function as a **${partOfSpeech}**. Discard any that do not fit this grammatical role. For example, if the part of speech is 'verb', keep 'watch' and 'look after', but discard nouns like 'guardian'.
2.  Create 3-4 semantic facets (axes) for the hub word.
3.  If a Focus Category is provided, one facet MUST relate to it.
4.  For each word from your **filtered, grammatically-correct list**, generate: facet index, ring (0-3), frequency (0-100), a brief definition, a natural usage example, a difficulty rating ('beginner', 'intermediate', or 'advanced'), and intensity scores for all facets.
5.  Ensure the classified words are distributed logically across ALL facets. Do not assign all words to just one facet.

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

async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key is not configured.');

    const modelsToTry = [
        "openrouter/sonoma-sky-alpha",
        "openrouter/sonoma-dusk-alpha",
        "mistralai/mistral-small-3.2-24b-instruct:free",
        "openai/gpt-oss-120b:free",
        "google/gemini-flash-1.5-8b"
    ];

    for (const model of modelsToTry) {
        console.log(`Attempting API call with model: ${model}`);
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: model, response_format: { type: "json_object" },
                    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }]
                })
            });

            if (!response.ok) {
                const errorBody = await response.text();
                console.warn(`Model '${model}' failed with status ${response.status}: ${errorBody}`);
                continue;
            }

            const data = await response.json();

            if (data.choices && data.choices.length > 0 && data.choices[0].message?.content) {
                console.log(`Successfully received response from: ${model}`);
                const messageContent = data.choices[0].message.content;
                
                try {
                    return JSON.parse(messageContent);
                } catch (parseError) {
                    console.warn(`Model '${model}' returned unparseable JSON. Trying next model.`);
                    continue;
                }
            } else {
                console.warn(`Model '${model}' returned no choices. Trying next model.`);
            }
        } catch (error) {
            console.error(`An unexpected network error occurred with model '${model}':`, error);
        }
    }

    throw new Error("All AI models failed to provide a valid response. Please try again later.");
}

async function getCachedLlmResponse({ word, partOfSpeech, category, synonyms }, store) {
    const cacheKey = generateCacheKey({ word, partOfSpeech, category, synonyms });
    
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
    const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, synonyms);
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
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { word, partOfSpeech, category, synonyms } = body;
        
        if (!word || !partOfSpeech) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: "Word and Part of Speech are required." }) };
        }
        
        let store;
        try {
            store = getStore("word-radar-cache");
        } catch (storeError) {
            console.warn('Failed to initialize blob store:', storeError.message);
            store = null;
        }
        
        if (synonyms && synonyms.length > 0) {
            let apiResponse;
            if (store) {
                apiResponse = await getCachedLlmResponse({ word, partOfSpeech, category, synonyms }, store);
            } else {
                const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, synonyms);
                apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
            }
            apiResponse.hub_word = word;
            apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        const MW_API_KEY = process.env.MW_THESAURUS_API_KEY;
        if (!MW_API_KEY) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Merriam-Webster API key is not configured.' }) };
        }

        const url = `https://www.dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${MW_API_KEY}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`MW API request failed: ${response.status}`);
        
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== 'object') {
            return { statusCode: 404, headers, body: JSON.stringify({ error: `No entries found for "${word}".` }) };
        }
        
        // --- MODIFIED SECTION: Smarter Sense Parsing and De-duplication Logic ---
        const senseMap = new Map();

        const allRawSenses = data
            .filter(entry => entry.fl === partOfSpeech)
            .flatMap(entry => {
                if (!entry.def || !entry.def[0] || !entry.def[0].sseq) return [];
                return entry.def[0].sseq.map(sense_block => {
                    const sense_data = sense_block[0][1];
                    let definition = (sense_data.dt && sense_data.dt[0] && sense_data.dt[0][1]) || sense_data.shortdef?.[0] || 'General sense';
                    definition = definition.replace(/{.*?}/g, '').trim();
                    const synonyms = (sense_data.syn_list || [])
                        .flatMap(syn_group => syn_group.map(syn => syn.wd))
                        .slice(0, 25);
                    return { definition, synonyms };
                });
            });

        // De-duplicate by grouping synonyms under the same definition
        for (const sense of allRawSenses) {
            if (sense.synonyms.length > 0) {
                if (senseMap.has(sense.definition)) {
                    const existingSyns = senseMap.get(sense.definition);
                    sense.synonyms.forEach(syn => existingSyns.add(syn));
                } else {
                    senseMap.set(sense.definition, new Set(sense.synonyms));
                }
            }
        }
        
        const senses = Array.from(senseMap.entries()).map(([definition, synSet]) => ({
            definition,
            synonyms: Array.from(synSet)
        }));
        // --- END OF MODIFIED SECTION ---

        if (senses.length === 0) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: `No synonyms found for "${word}" as a ${partOfSpeech}.` }) };
        }
        
        if (senses.length === 1) {
            console.log(`Single sense found for "${word}", proceeding directly to generation.`);
            let apiResponse;
            if (store) {
                apiResponse = await getCachedLlmResponse({ word, partOfSpeech, category, synonyms: senses[0].synonyms }, store);
            } else {
                const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSspeech, category, senses[0].synonyms);
                apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
            }
            apiResponse.hub_word = word;
            apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, headers, body: JSON.stringify(apiResponse) };
        }

        console.log(`Multiple de-duplicated senses (${senses.length}) found for "${word}", returning for user selection.`);
        return { statusCode: 200, headers, body: JSON.stringify({ senses }) };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Server error: ${error.message}` }) };
    }
};