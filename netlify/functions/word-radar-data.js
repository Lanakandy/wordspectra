// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');

// fetchSynonyms function is no longer needed as we'll parse senses directly.
// getLLMPrompt and callOpenRouterWithFallback remain the same.

// --- (Paste the existing getLLMPrompt and callOpenRouterWithFallback functions here) ---
function getLLMPrompt(word, partOfSpeech, category, synonyms) {
    const systemPrompt = `You are a linguist creating a Word Radar visualization dataset. You will be given a hub word, a part of speech, and a list of related words. Your task is to filter and classify these words.

REQUIREMENTS:
1.  **FILTER FIRST:** From the provided "Synonyms" list, you MUST select ONLY the words that function as a **${partOfSpeech}**. Discard any words that do not fit this grammatical role. For example, if the part of speech is 'verb', discard nouns like 'guardian' or 'lookout'.
2.  Create 3-4 semantic facets (axes) for the hub word.
3.  If a Focus Category is provided, one facet MUST relate to it.
4.  For each word from your **filtered, grammatically-correct list**, generate: facet index, ring (0-3), frequency (0-100), a brief definition, a natural usage example, and intensity scores for all facets.
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


// --- START: MODIFIED HANDLER ---
exports.handler = async function(event) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        const { word, partOfSpeech, category, synonyms } = body; // Check for incoming synonyms list
        
        if (!word || !partOfSpeech) {
            return { statusCode: 400, body: JSON.stringify({ error: "Word and Part of Speech are required." }) };
        }
        
        // --- WORKFLOW 2: GENERATION ---
        // If a list of synonyms is provided, skip discovery and generate the radar
        if (synonyms && synonyms.length > 0) {
            console.log("Received pre-selected synonyms. Generating radar...");
            const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, synonyms);
            const apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
            apiResponse.hub_word = word;
            apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, body: JSON.stringify(apiResponse) };
        }

        // --- WORKFLOW 1: DISCOVERY ---
        // If no synonyms are provided, discover the senses of the word
        console.log(`Discovering senses for "${word}"...`);
        const MW_API_KEY = process.env.MW_THESAURUS_API_KEY;
        const url = `https://www.dictionaryapi.com/api/v3/references/thesaurus/json/${encodeURIComponent(word)}?key=${MW_API_KEY}`;
        const response = await fetch(url);

        if (!response.ok) throw new Error(`MW API request failed: ${response.status}`);
        
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== 'object') {
            return { statusCode: 404, body: JSON.stringify({ error: `No entries found for "${word}".` }) };
        }
        
        // Filter entries by the correct part of speech and extract senses
        const senses = data
            .filter(entry => entry.fl === partOfSpeech)
            .map(entry => ({
                definition: entry.shortdef[0] || "General sense",
                synonyms: [...new Set(entry.meta.syns.flat())].slice(0, 25)
            }))
            .filter(sense => sense.synonyms.length > 0);

        if (senses.length === 0) {
            return { statusCode: 404, body: JSON.stringify({ error: `No synonyms found for "${word}" as a ${partOfSpeech}.` }) };
        }
        
        // OPTIMIZATION: If only one sense is found, just generate the radar directly
        if (senses.length === 1) {
            console.log("Only one sense found. Generating radar directly.");
            const singleSenseSynonyms = senses[0].synonyms;
            const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category, singleSenseSynonyms);
            const apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
            apiResponse.hub_word = word;
            apiResponse.part_of_speech = partOfSpeech;
            return { statusCode: 200, body: JSON.stringify(apiResponse) };
        }

        // If multiple senses exist, return them to the user for selection
        console.log(`Found ${senses.length} senses. Returning for user selection.`);
        return { statusCode: 200, body: JSON.stringify({ senses }) };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
// --- END: MODIFIED HANDLER ---