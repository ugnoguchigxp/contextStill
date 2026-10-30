import { expect, test } from "bun:test";
import { SearchError, errorStatus } from "../index";

test("SearchError carries its code as message and code", () => {
	const error = new SearchError("space_not_allowed");
	expect(error).toBeInstanceOf(Error);
	expect(error.code).toBe("space_not_allowed");
	expect(error.message).toBe("space_not_allowed");
	expect(errorStatus).toEqual({ invalid_query: 400, space_not_allowed: 403 });
});
