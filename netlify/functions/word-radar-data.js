// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');

/**
 * Fetches synonyms from the Merriam-Webster Collegiate Thesaurus API.
 * @param {string} word The word to look up.
 * @param {string} apiKey Your MW Thesaurus API key.
 * @returns {Promise<string[]>} A promise that resolves to an array of unique synonyms.
 */
async function fetchSynonyms(word, apiKey) {
    if (!apiKey) {
        throw new Error('Merriam-Webster API key is not configured.');
    }
    const url = `https://www.dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${apiKey}`;
    console.log(`Fetching synonyms for "${word}" from MW API.`);
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Merriam-Webster API request failed with status: ${response.status}`);
    }

    const data = await response.json();

    // MW API returns an array. If it's empty or the first item is a string, no results were found.
    if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== 'object') {
        console.log(`No valid synonym entries found for "${word}".`);
        return [];
    }

    // Extract synonyms from all senses of the word.
    // `meta.syns` is a nested array, e.g., [["observe", "witness"], ["perceive"]]
    const allSynonyms = data.flatMap(entry => entry.meta?.syns?.flat() || []);
    
    // Return a unique, capped list of synonyms.
    const uniqueSynonyms = [...new Set(allSynonyms)];
    console.log(`Found ${uniqueSynonyms.length} unique synonyms. Capping at 25.`);
    return uniqueSynonyms.slice(0, 25);
}


/**
 * Generates the system and user prompts for the LLM, now including a list of synonyms.
 * The LLM's task is to CLASSIFY the provided words, not generate them.
 */
function getLLMPrompt(word, partOfSpeech, category, synonyms) {
    const systemPrompt = `You are a linguist creating a Word Radar visualization dataset. You will be given a hub word and a list of its synonyms. Your task is to analyze and classify ONLY the words from the provided list.

REQUIREMENTS:
1. Create 3-4 semantic facets (axes) for the hub word.
2. If a Focus Category is provided, one facet MUST relate to it.
3. Analyze EACH word from the provided "Synonyms" list. Do NOT invent new words.
4. For each synonym, generate: facet index, ring (0-3), frequency (0-100), a brief definition, a natural usage example, and intensity scores for all facets.
5. Ensure the provided words are distributed logically across ALL facets. Do not assign all words to just one facet.

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
      "term": "synonym_from_list",
      "facet": 0,
      "ring": 1,
      "frequency": 65,
      "definition": "Brief, clear definition for this specific synonym.",
      "example": "Natural usage example for the synonym.",
      "intensities": {"dimension_key": 0.5, "other_key": -0.3}
    }
  ]
}

Return ONLY valid JSON.`;

    let userPrompt = `Hub Word: "${word}"\nPart of Speech: "${partOfSpeech}"\n\nSynonyms to classify:\n[${synonyms.map(s => `"${s}"`).join(', ')}]`;
    
    if (category) {
        userPrompt += `\n\nFocus Category: "${category}"`;
    }
    
    return { systemPrompt, userPrompt };
}


// This function remains the same as before
async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error('OpenRouter API key is not configured.');

    const modelsToTry = [
        "google/gemini-2.0-flash-exp:free", 
        "mistralai/mistral-small-3.2-24b-instruct:free",
        "mistralai/mistral-7b-instruct:free",
        "google/gemini-flash-1.5-8b"
    ];

    for (const model of modelsToTry) {
        console.log(`Attempting API call with model: ${model}`);
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: model,
                    response_format: { type: "json_object" },
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

exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const { word, partOfSpeech, category } = body;
        
        if (!word || !partOfSpeech) {
            return { statusCode: 400, body: JSON.stringify({ error: "Word and Part of Speech are required." }) };
        }
        
        // --- NEW WORKFLOW ---
        // 1. Fetch synonyms from Merriam-Webster API
        const MW_API_KEY = process.env.MW_THESAURUS_API_KEY;
        const synonyms = await fetchSynonyms(word, MW_API_KEY);
        
        if (synonyms.length === 0) {
            return { 
                statusCode: 404, 
                body: JSON.stringify({ error: `No synonyms found for "${word}". Please try another word.` }) 
            };
        }
        
        // 2. Build a new prompt with the fetched synonyms
        const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, synonyms);
        
        // 3. Call the LLM to classify the synonyms
        const apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
        
        // Ensure the hub word is correctly set in the response
        apiResponse.hub_word = word;
        apiResponse.part_of_speech = partOfSpeech;
        
        return { statusCode: 200, body: JSON.stringify(apiResponse) };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};