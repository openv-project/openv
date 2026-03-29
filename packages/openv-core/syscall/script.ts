import type { SystemComponent } from "@openv-project/openv-api";

export const SCRIPT_EVAL_NAMESPACE = "party.openv.script.eval";
export const SCRIPT_EVAL_NAMESPACE_VERSIONED = "party.openv.script.eval/0.1.0";

export interface ScriptEvaluatorComponent
  extends SystemComponent<
    typeof SCRIPT_EVAL_NAMESPACE_VERSIONED,
    typeof SCRIPT_EVAL_NAMESPACE
  > {
  /**
   * Evaluate JavaScript code in the service worker context.
   * The openv global is available to evaluated scripts.
   * @param code The JavaScript code to evaluate
   * @param context Optional context object to inject variables into scope
   * @returns The result of the evaluation
   */
  ["party.openv.script.eval.evaluate"](
    code: string,
    context?: Record<string, unknown>
  ): Promise<unknown>;
}

export class CoreScriptEvaluator implements ScriptEvaluatorComponent {
  async supports(ns: typeof SCRIPT_EVAL_NAMESPACE | typeof SCRIPT_EVAL_NAMESPACE_VERSIONED): Promise<typeof SCRIPT_EVAL_NAMESPACE_VERSIONED>;
  async supports(ns: string): Promise<string | null> {
    if (ns === SCRIPT_EVAL_NAMESPACE || ns === SCRIPT_EVAL_NAMESPACE_VERSIONED) {
      return SCRIPT_EVAL_NAMESPACE_VERSIONED;
    }
    return null;
  }

  async ["party.openv.script.eval.evaluate"](
    code: string,
    context?: Record<string, unknown>
  ): Promise<unknown> {
    try {
      if (context) {
        const keys = Object.keys(context);
        const values = Object.values(context);
        const fn = new Function(...keys, `return (async () => { ${code} })()`);
        return await fn(...values);
      }
      const fn = new Function(`return (async () => { ${code} })()`);
      return await fn();
    } catch (error) {
      throw new Error(
        `Script evaluation failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
