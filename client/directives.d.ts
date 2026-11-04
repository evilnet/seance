import type {Directive} from "vue";

declare module "vue" {
	interface GlobalDirectives {
		vSwitch: Directive;
		vBackdrop: Directive;
	}
}
