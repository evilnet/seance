import {expect} from "chai";
import {alertSound, AlertSoundCase} from "../../client/js/helpers/notificationSound";

const base: AlertSoundCase = {
	soundOn: true,
	native: false,
	notifying: true,
	osSound: true,
	ios: false,
	visible: true,
};

describe("alertSound", function () {
	it("leaves the sound to a system notification on a desktop", function () {
		expect(alertSound(base)).to.deep.equal({inPage: false, silentNotification: false});
		expect(alertSound({...base, visible: false})).to.deep.equal({
			inPage: false,
			silentNotification: false,
		});
	});

	it("plays in the page when there is no notification to carry it", function () {
		expect(alertSound({...base, notifying: false})).to.deep.equal({
			inPage: true,
			silentNotification: true,
		});
	});

	it("plays in the page where the platform's notifications are silent", function () {
		expect(alertSound({...base, osSound: false})).to.deep.equal({
			inPage: true,
			silentNotification: true,
		});
	});

	it("plays in the page on iOS while the web app is on screen, the notification silent", function () {
		expect(alertSound({...base, ios: true})).to.deep.equal({
			inPage: true,
			silentNotification: true,
		});
	});

	it("leaves it to the notification on iOS while the web app is in the background", function () {
		expect(alertSound({...base, ios: true, visible: false})).to.deep.equal({
			inPage: false,
			silentNotification: false,
		});
	});

	it("never plays in a native shell, where the OS alert has the sound", function () {
		expect(alertSound({...base, native: true, ios: true})).to.deep.equal({
			inPage: false,
			silentNotification: false,
		});
	});

	it("is silent everywhere with the sound setting off", function () {
		for (const c of [base, {...base, notifying: false}, {...base, ios: true}]) {
			expect(alertSound({...c, soundOn: false})).to.deep.equal({
				inPage: false,
				silentNotification: true,
			});
		}
	});
});
