import { describe, expect, test } from "bun:test";
import { verifiesNativeMotionAnswer } from "../src/actions";

describe("native motion verification", () => {
	test.each([
		"The square moves right, first black and later red.",
		"The square moves to the right. Its color changes from black to red.",
		"Rightward motion; black first and red second.",
		"The square travels from left to right, changing from black to red.",
	])("accepts explicit direction and temporal color order: %s", answer => {
		expect(verifiesNativeMotionAnswer(answer)).toBe(true);
	});

	test.each([
		"The square moves from right to left, changing from black to red.",
		"The square is black and then red.",
		"The square moves to the right.",
		"The square moves to the right and changes from red to black.",
	])("rejects missing or reversed temporal evidence: %s", answer => {
		expect(verifiesNativeMotionAnswer(answer)).toBe(false);
	});
});
