// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');

/**
 * Generates the system and user prompts for the LLM.
 * This is the core logic for the Word Radar data generation.
 */
function getLLMPrompt(word) {
    const systemPrompt = `
You are a computational linguist creating JSON data for a Word Radar visualization.

TASK: Analyze "${word}" and output ONLY valid JSON with this exact structure:

{
  "hub_word": "input word",
  "part_of_speech": "primary POS (noun/verb/adjective/adverb)",
  "facets": [
    {"name": "Spectrum Name", "key": "lowercase_key", "spectrumLabels": ["Low End", "High End"]}
  ],
  "rings": ["Core", "Common", "Specific", "Nuanced"],
  "words": [
    {
      "term": "related word",
      "facet": 0,
      "ring": 1,
      "frequency": 65,
      "definition": "Brief definition",
      "example": "Natural example sentence",
      "intensities": {"key1": 0.3, "key2": -0.7}
    }
  ]
}

REQUIREMENTS:
1. Use the most common part of speech for the input word
2. Create 2-4 facets (semantic dimensions) - each with name, key, and spectrumLabels
3. Generate 12-16 related words, each with:
   - facet: index (0-3) of which dimension it represents
   - ring: distance from center (0=core, 3=peripheral)
   - frequency: commonality (0-100)
   - intensities: score (-1.0 to 1.0) for ALL facet keys

Output ONLY the JSON - no explanations or markdown.`;

    const userPrompt = word;
    
    return { systemPrompt, userPrompt };
}

async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error('API key is not configured.');

    const modelsToTry = [
        "tngtech/deepseek-r1t2-chimera:free",
        "google/gemini-2.0-flash-exp:free", 
        "mistralai/mistral-small-3.2-24b-instruct:free"
        
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
        const { word } = body;
        
        if (!word) {
            return { statusCode: 400, body: JSON.stringify({ error: "Word is required." }) };
        }

        const { systemPrompt, userPrompt } = getLLMPrompt(word);
        
        const apiResponse = await callOpenRouterWithFallback(systemPrompt, userPrompt);
        
        return { statusCode: 200, body: JSON.stringify(apiResponse) };

    } catch (error) {
        console.error("Function Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};