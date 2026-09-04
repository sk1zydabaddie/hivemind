import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import replayData from "../tools/replay-data.json";

// Captured before untracking the generated file. Hashes cover recorded events,
// patches and output; scratch paths, check timing and run IDs are not stable.
const captured = [
  ["e2e-textkit-parallel-run",105,true,14,"35b009205223f6b00a632e1bbd3843af1f6524e700a496b28b485433fb010e80"],
  ["e2e-textkit-parallel-run@midrun",37,true,0,"d22efe23eda20a9eefcbc3fdfaa4ea385a0bb48fe55e805eb5ec086afb1a96e1"],
  ["e2e-textkit-parallel-run@ship",104,true,0,"4a7499b50a66fdd0b2ec4e925bc4f87df2aa71dcbcfeba24c873c414ef024a22"],
  ["e2e-textkit-parallel-run@ship-review",104,true,0,"4a7499b50a66fdd0b2ec4e925bc4f87df2aa71dcbcfeba24c873c414ef024a22"],
  ["empty-project",0,true,0,"94b94e787248beeea7456cd72dc35432aa2ea420e9afede5dac44943154af8a7"],
  ["events",33,true,7,"35ce52ab3c4c9df6c5cee1e83aada69eb346586faf033b64d075af9d90069e72"],
  ["events@ship",32,true,0,"eea1273fc0cc871b57fdb11102ad53a02e3dfc65c450e7331269b35d2b77259f"],
  ["events@ship-review",32,true,0,"eea1273fc0cc871b57fdb11102ad53a02e3dfc65c450e7331269b35d2b77259f"],
  ["final-run-transcript-3",4,true,0,"f640374bb3396c98491763c1440f0883d213c7ba6a9f9b6b3d11cd19dbe516ce"],
  ["final-run-transcript-4",16,true,0,"c4e1cb7e82575a23e9145dc5b31ab7ba33b0bba40e9bfe4bde1dae274c511888"],
  ["first-message-live",2,true,0,"1a47b09ed289d8cac1b3a0ccc5a232a48f9189cd8604eb96d003f35f0fa8173a"],
  ["first-run",31,true,1,"377e4a8ee321607c157ded56e40433fdb433e3cd428b75d629b097d484556a46"],
  ["first-run@review-blocked",31,true,0,"bdf92bad4e7feeaa6a311dd30fbfddc37a0cec65b259a36d438cc6029895d5c6"],
  ["first-run@review-ready",31,true,0,"bdf92bad4e7feeaa6a311dd30fbfddc37a0cec65b259a36d438cc6029895d5c6"],
  ["firstrun-pending-plan",2,false,0,"46e8f5fc8d37dae3f07e69fb6690da9535540ee326443a50d7bed796f198041b"],
  ["firstrun-quota-stop",2,false,0,"46e8f5fc8d37dae3f07e69fb6690da9535540ee326443a50d7bed796f198041b"],
  ["firstrun-quota-stop-2",16,false,0,"1ec6e116384e92a6ca7cf74f8fa64178c250d52524f9b8157eace4a97446f341"],
  ["full-plan-real-green-transcript",5,true,0,"dcef92702e2b6ce831311663c893e78c48f38476db24a8a82dab3aac156b3073"],
  ["full-plan-run-transcript",8,true,0,"5891738cad0fe3954517126672759a1a7bca4772b6878a5de21b406fc67fae8a"],
  ["gui-run",56,true,1,"7eadbd3ea499886d1861ebb2727a2cd418d0dafe272d662fbf508a9cd0e3a885"],
  ["linux-first-run",31,true,1,"043565a87a3179bf73ab9c032f38cf8e44a40a35efc1a8be626b80ce1219bdd9"],
  ["m6-2-async-events",13,true,0,"aeb394cba91f0d1ce55d4131de5dd9a9f9506e9b6022caca0db5252fd0e4be4e"],
  ["m7-4-consolidation-behavioral",12,true,0,"bb9b0aad31e5b8476206d04c4777b2901b083164d0553102b81ef3a32a7af937"],
  ["manager-transcript",7,true,0,"835664b7ff9aaa804c7f17b654947f732a7cec130cc3b145e092a2c9ec6aea9e"],
  ["walk4-prompt-to-shipped",33,true,7,"d03a1c135a9b9e229319f6a712985802a457294852d3bc108b4be916da9c71ce"],
  ["walk4-prompt-to-shipped@ship",32,true,0,"84243560acbf9edcc4d610715c7b32a6c7b57586b4f834be5f382356848de279"],
  ["walk4-prompt-to-shipped@ship-review",32,true,0,"84243560acbf9edcc4d610715c7b32a6c7b57586b4f834be5f382356848de279"],
  ["worker-sandbox-fix-transcript",9,true,0,"a21d6e1a7d16f4f0b46135296753bfa56bec653927a8284ea2743354619fda93"],
];

describe("replay data generated from a clean checkout", () => {
  test("preserves every captured scenario and its recorded content", () => {
    const actual = replayData.scenarios.map((scenario) => {
      const value = scenario as {
        id: string; events: unknown[]; inspection: unknown;
        timeline?: unknown[]; patches?: unknown; output?: unknown;
      };
      return [
        value.id, value.events.length, value.inspection !== null,
        value.timeline?.length ?? 0,
        createHash("sha256")
          .update(JSON.stringify([value.events, value.patches ?? null, value.output ?? null]))
          .digest("hex")
      ];
    }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    expect(actual).toEqual(captured);
  });

  test("every npm fixture consumer generates data against freshly built Core first", async () => {
    const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const command of ["dev", "build", "test", "verify:reachable"]) {
      expect(scripts[`pre${command}`]).toBe("npm run replay:collect");
    }
    expect(scripts["replay:collect"]).toBe("npm --prefix .. run build && node tools/collect-replay.mjs");
  });

  test("the in-flight capture is projected at its own time, not aged into recovery", () => {
    const live = replayData.scenarios.find((scenario) => scenario.id === "first-message-live")!;
    expect(live.inspection).not.toBeNull();
    expect((live.inspection as { silent_rounds: string[] }).silent_rounds).toEqual([]);
    expect(live.inspection!.needs_you.some((item) => item.kind === "recovery_required")).toBe(false);
  });
});
