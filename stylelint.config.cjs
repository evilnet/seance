module.exports = {
	extends: "stylelint-config-standard",
	rules: {
		"declaration-block-no-redundant-longhand-properties": null,
		"import-notation": "string",
		"media-feature-range-notation": "prefix",
		"font-family-no-missing-generic-family-keyword": null,
		"no-descending-specificity": null,
		"selector-class-pattern": null,
		"selector-id-pattern": null,
		// `:not(.a, .b)` is less specific than `:not(.a):not(.b)`, so --fix would change what wins.
		"selector-not-notation": null,
	},
};
