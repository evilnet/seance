// The part of fasttext.wasm.js that lid.real.ts uses. The package's own .d.ts
// (dist/core/fastText*.d.ts) is not valid TypeScript (a bare `const` at the
// top level), so the client's tsconfig points the import here instead.
declare module "fasttext.wasm.js/common" {
	export interface IdentifyLang {
		alpha2: string | null;
		alpha3: string;
		refName: string;
		possibility: number;
	}

	export interface LanguageIdentificationModel {
		load(): Promise<unknown>;
		identify(text: string, k: number): Promise<IdentifyLang[]>;
	}

	export function getLIDModel(options: {
		wasmPath: string;
		modelPath: string;
	}): Promise<LanguageIdentificationModel>;
}
