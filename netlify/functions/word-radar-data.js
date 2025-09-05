// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');

/**
 * Generates the system and user prompts for the LLM.
 * This is the core logic for the Word Radar data generation.
 */
function getLLMPrompt(word, partOfSpeech, category) {
    const systemPrompt = `You are a linguist creating a Word Radar visualization dataset. Generate a JSON object analyzing semantic relationships for the given word.

REQUIREMENTS:
1. Create 3-4 semantic facets (axes) based on the word's meaning
2. If a Focus Category is provided, one facet MUST relate to it
3. Generate 15-25 related words distributed across ALL facets
4. Each word needs: term, facet index, ring (0-3), frequency (0-100), definition, example, and intensity scores

FACET DISTRIBUTION RULE: Words must be spread across facets. Do not assign all words to one facet.

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
      "term": "example",
      "facet": 0,
      "ring": 1,
      "frequency": 65,
      "definition": "Brief, clear definition.",
      "example": "Natural usage example.",
      "intensities": {"dimension_key": 0.5, "other_key": -0.3}
    }
  ]
}

Return ONLY valid JSON.`;

    let userPrompt = `Word: "${word}"\nPart of Speech: "${partOfSpeech}"`;
    if (category) {
        userPrompt += `\nFocus Category: "${category}"`;
    }
    
    return { systemPrompt, userPrompt };
}

// Rest of the file remains the same
async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error('API key is not configured.');

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

        const { systemPrompt, userPrompt } = getLLMPrompt(word, partOfSpeech, category);
        
        const apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
        
        return { statusCode: 200, body: JSON.stringify(apiResponse) };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};