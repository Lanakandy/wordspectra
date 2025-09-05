// netlify/functions/word-radar-data.js

const fetch = require('node-fetch');

/**
 * Generates the system and user prompts for the LLM.
 * This is the core logic for the Word Radar data generation.
 */
function getLLMPrompt(word, partOfSpeech, category) {
    const systemPrompt = `
You are a linguist and data visualization expert. Your task is to analyze a central English word and generate a complete JSON dataset for a 'Word Radar' visualization to provide nuanced understanding of English synonyms and synonymous expressions.

Your process must be methodical and precise. Follow these steps exactly:

**Step 1: Define 2 to 4 Semantic Facets (The Quadrants)**
-   Based on the user-provided word and part of speech, choose two, three, or four distinct, meaningful semantic spectra. These will be the radar's axes.
-   **IMPORTANT**: If the user provides a "Focus Category," you MUST create a facet that directly relates to it.
-   For each facet, define its \`name\`, \`key\`, and \`spectrumLabels\`.

**Step 2: Generate Words FOR EACH FACET and Combine**
-   This step is CRITICAL. You must generate words in batches, one batch for each facet you defined in Step 1.
-   For EACH facet (e.g., "Formality", "Intensity"), generate up to 10 related words that strongly exemplify that specific semantic dimension.
-   **ENSURE DIVERSITY**: The final list of words MUST be distributed across all the facets you created. Do not assign all words to a single facet index.
-   For EACH word, you MUST provide:
    -   \`term\`: The word itself.
    -   \`facet\`: The index (0-3) of the facet it belongs to. This MUST be correct.
    -   \`ring\`: An index from 0 (most central) to 3 (most peripheral) representing conceptual distance.
    -   \`frequency\`: An estimated integer from 0 (very rare) to 100 (very common).
    -   \`definition\`: A concise, one-sentence definition.
    -   \`example\`: A natural, everyday example sentence.
    -   \`intensities\`: An object with a score from -1.0 to 1.0 for EACH of the facet keys defined in Step 1.

**Step 3: Final Verification**
-   Before generating the final JSON, mentally review your list of words. Confirm that you have assigned words to multiple different facet indexes (e.g., words with \`"facet": 0\`, \`"facet": 1\`, and \`"facet": 2\`).

**Final JSON Structure:**
Your entire response MUST be ONLY a single, valid JSON object. Do not include any text outside the JSON. The 'words' array should contain a mix of words from all created facets.

\`\`\`json
{
  "hub_word": "The original word",
  "part_of_speech": "The user-provided part of speech, e.g., verb",
  "facets": [
    { "name": "e.g., Speed & Pace", "key": "speed", "spectrumLabels": ["Leisurely", "Hurried"] },
    { "name": "e.g., Formality & Purpose", "key": "formality", "spectrumLabels": ["Casual", "Official"] },
    { "name": "e.g., Difficulty of Terrain", "key": "terrain", "spectrumLabels": ["Easy", "Difficult"] }
  ],
  "rings": ["Core", "Common", "Specific", "Nuanced"],
  "words": [
    {
      "term": "stroll",
      "facet": 0,
      "ring": 1,
      "frequency": 45,
      "definition": "To walk in a leisurely way.",
      "example": "They strolled through the park on Sunday afternoon.",
      "intensities": { "speed": -0.8, "formality": -0.4, "terrain": -0.5 }
    },
    {
      "term": "march",
      "facet": 1,
      "ring": 2,
      "frequency": 30,
      "definition": "To walk in a military manner with a regular measured tread.",
      "example": "The soldiers marched in perfect formation.",
      "intensities": { "speed": 0.3, "formality": 0.9, "terrain": 0.1 }
    },
    {
      "term": "hike",
      "facet": 2,
      "ring": 2,
      "frequency": 55,
      "definition": "To walk for a long distance, especially across country or in the woods.",
      "example": "We plan to hike the entire trail next summer.",
      "intensities": { "speed": -0.2, "formality": -0.6, "terrain": 0.8 }
    }
  ]
}
\`\`\`
`;
    // Build the user prompt with the new information
    let userPrompt = `Central Word: "${word}"\nPart of Speech: "${partOfSpeech}"`;
    if (category) {
        userPrompt += `\nFocus Category: "${category}"`;
    }
    
    return { systemPrompt, userPrompt };
}

// ... (the rest of the file, callOpenRouterWithFallback and handler, remains exactly the same) ...

async function callOpenRouterWithFallback(systemPrompt, userPrompt) {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error('API key is not configured.');

    const modelsToTry = [
        "meta-llama/llama-3.1-8b-instruct",
        "google/gemini-2.0-flash-exp:free",
        "mistralai/mistral-small-3.2-24b-instruct:free",
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