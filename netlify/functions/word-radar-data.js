// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');

/**
 * Generates the system and user prompts for the LLM.
 * This is the core logic for the Word Radar data generation.
 */
function getLLMPrompt(word) {
    const systemPrompt = `
You are a brilliant computational linguist and data visualization expert. Your task is to analyze a central English word and generate a complete JSON dataset for a 'Word Radar' visualization.

Follow these instructions meticulously:

**Step 1: Determine the Primary Part of Speech**
-   Analyze the central word and identify its single, most common part of speech (e.g., for "watch", choose "verb" over "noun").
-   The entire analysis MUST be based on this single part of speech.

**Step 2: Define 2 to 4 Semantic Facets (The Quadrants)**
-   Choose two, three, or four distinct, meaningful semantic spectra that best describe the nuances of related words. These will be the radar's axes.
-   For each facet, provide:
    -   \`name\`: A human-readable title (e.g., "Intensity & Force").
    -   \`key\`: A single, lowercase programmatic key (e.g., "intensity").
    -   \`spectrumLabels\`: A two-element array of strings for the ends of the spectrum, corresponding to scores of -1.0 and 1.0 (e.g., ["Subtle", "Forceful"]).

**Step 3: Generate 12-16 Related Words (The Bubbles)**
-   Create a list of related English words (synonyms, antonyms, related concepts) for the determined part of speech.
-   For EACH word, you MUST provide the following attributes:
    -   \`term\`: The word itself.
    -   \`facet\`: The index (0-3) of the facet it belongs to.
    -   \`ring\`: An index from 0 (most central) to 3 (most peripheral) representing conceptual distance.
    -   \`frequency\`: An estimated integer from 0 (very rare) to 100 (very common).
    -   \`definition\`: A concise, one-sentence definition.
    -   \`example\`: A natural, everyday example sentence.
    -   \`intensities\`: **CRITICAL**. An object containing a score from -1.0 to 1.0 for EACH of the facet keys you defined.

**Final JSON Structure:**
Your entire response MUST be ONLY a single, valid JSON object matching this structure. Do not include any explanations, markdown, or text outside the JSON.

\`\`\`json
{
  "hub_word": "The original word",
  "part_of_speech": "The most common part of speech, e.g., verb",
  "facets": [
    { "name": "e.g., Formality", "key": "formality", "spectrumLabels": ["Casual", "Formal"] },
    { "name": "e.g., Speed", "key": "speed", "spectrumLabels": ["Slow", "Fast"] }
  ],
  "rings": ["Core", "Common", "Specific", "Nuanced"],
  "words": [
    {
      "term": "e.g., glance",
      "facet": 0,
      "ring": 1,
      "frequency": 40,
      "definition": "A brief, hurried look.",
      "example": "She glanced at her watch.",
      "intensities": {
        "formality": -0.3,
        "speed": -0.8
      }
    }
  ]
}
\`\`\`
`;

    const userPrompt = `Central Word: "${word}"`;
    
    return { systemPrompt, userPrompt };
}

async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error('API key is not configured.');

    const modelsToTry = [
        "tngtech/deepseek-r1t-chimera:free",   
        "google/gemini-2.0-flash-exp:free", 
        "mistralai/mistral-small-3.2-24b-instruct:free",
        "google/gemini-2.0-flash-exp:free",      
        "tngtech/deepseek-r1t-chimera:free",        
        "tngtech/deepseek-r1t2-chimera:free",        
        "openai/gpt-oss-20b:free",
        "meta-llama/llama-3.1-8b-instruct"
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