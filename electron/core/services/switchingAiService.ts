import type { DevFlagsStore } from "../mock/devFlags";
import type { AiService } from "./aiService";

/** Sends each call to the mock AI while the dev panel's "Mock AI" is on, otherwise to the real one. */
export function switchingAiService(real: AiService, mock: AiService, flags: DevFlagsStore): AiService {
  const pick = () => (flags.get().mockAi ? mock : real);
  return {
    get canFixScripts() {
      return pick().canFixScripts;
    },
    readDocument: (...a) => pick().readDocument(...a),
    draftRoutine: (...a) => pick().draftRoutine(...a),
    answerQuestion: (...a) => pick().answerQuestion(...a),
    fixRoutine: (...a) => pick().fixRoutine(...a),
    reviewTrial: (...a) => pick().reviewTrial(...a),
    explainFailure: (...a) => pick().explainFailure(...a),
    repairRoutine: (...a) => pick().repairRoutine(...a),
    reviewOutput: (...a) => pick().reviewOutput(...a),
  };
}
