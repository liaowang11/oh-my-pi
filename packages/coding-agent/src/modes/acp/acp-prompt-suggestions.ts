/**
 * The follow-up prompt omp predicts for the next turn, on the wire.
 *
 * With `composer.predictions` on, a prompt turn that ends normally runs the
 * composer-prediction side turn and publishes its result as
 * `session_info_update._meta.promptSuggestions`, the key claude-agent-acp
 * uses. ACP has no field for it; a client that does not read the key sees a
 * session info update that says nothing. Clients such as agent-shell show the
 * first suggestion in an empty prompt.
 */

/** The `_meta` key the suggestions travel under. It names no vendor. */
export const PROMPT_SUGGESTIONS_META_KEY = "promptSuggestions";

/** The predicted prompts, most likely first, as the `_meta` value carries them. */
export interface PromptSuggestionsMetaValue {
	suggestions: { text: string }[];
}

/**
 * The `_meta` of the session info update that publishes `choices`. An empty
 * list clears the prompt the client holds: a prompt was sent, so the previous
 * prediction no longer applies.
 */
export function promptSuggestionsMeta(choices: readonly string[]): Record<string, PromptSuggestionsMetaValue> {
	return { [PROMPT_SUGGESTIONS_META_KEY]: { suggestions: choices.map(text => ({ text })) } };
}
