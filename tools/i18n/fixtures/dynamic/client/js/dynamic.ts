// The assembled-call-site fixture: every line below is one kind of site
// check.ts must flag. The two trailing lines are the lookalikes it must NOT
// flag: a property access and a definition are not call sites.
const key = "dynamic.key";
t(key);
t(`prefix.${key}`);
t("glued." + key);
const joined = t("clean.key") + " more";
const gluedCall = "see " + t("clean.key");
obj.t(key);
function t(key, vars) {
	return key;
}
