import nextJest from "next/jest.js";

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  // Not "<rootDir>/...": these are regexes, and the checkout path may contain regex characters such as "(1)".
  testPathIgnorePatterns: ["/node_modules/", "/\\.next/"],
  modulePathIgnorePatterns: ["/\\.next/"],
};

export default createJestConfig(customJestConfig);
