module.exports = {
	clearMocks: true,
	moduleFileExtensions: ['js', 'ts'],
	testEnvironment: './jest.environment.js',
	testMatch: ['**/*.test.ts'],
	transform: {
		'^.+\\.ts$': 'ts-jest',
	},
	verbose: true,
};
