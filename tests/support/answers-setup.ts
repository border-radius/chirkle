// The integration tests' setup file: a test whose SDK calls got an answer that doesn't fit its route's schema fails
// (tests/support/answers.ts). One made in a beforeAll fails the file's last test, or the file.
import { afterAll, afterEach } from "vitest";
import { takeMismatches } from "./answers.ts";

const fail = () => {
  const found = takeMismatches();
  if (found.length) throw new Error(found.join("\n\n"));
};
afterEach(fail);
afterAll(fail);
