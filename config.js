export const ENVIRONMENTS = {
	local: {
		match: "http://localhost/*",
		apiOrigin: "http://localhost:3000",
	},
	production: {
		match: "https://cstraders.com.br/*",
		apiOrigin: null,
	},
};

/** Ambientes válidos fora do build da Store. O release remove `local`. */
export const DEV_ONLY_ENVIRONMENTS = ["local"];
