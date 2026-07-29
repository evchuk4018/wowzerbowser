import { NextResponse } from "next/server";
import {
  BuiltinSkillDeleteError,
  CustomSkillLimitError,
  SkillNotFoundError,
} from "../../server/skills/skill-service";

export function skillRouteError(error: unknown, fallback: string) {
  if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (error instanceof SkillNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof BuiltinSkillDeleteError || error instanceof CustomSkillLimitError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const message = error instanceof Error ? error.message : "";
  if (/required|must be|at most|only built-in/i.test(message)) {
    return NextResponse.json({ error: message }, { status: 400 });
  }
  if (/already exists/i.test(message)) return NextResponse.json({ error: message }, { status: 409 });
  return NextResponse.json({ error: fallback }, { status: 503 });
}
