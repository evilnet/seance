// The unread badge. The abbreviation is the active locale's compact number
// format — en "1.5K", de "15.000" (German abbreviates from 10,000, so 1500
// stays full-width there), Arabic-Indic digits in ar-EG — replacing the old
// hardcoded (count/1000).toFixed(2) + "k". A badge is a number, not a
// label: nothing here can trip the i18n missing-key warnings.
import {formatCompact, formatNumber} from "../i18n/numbers";

export default (count: number) => (count < 1000 ? formatNumber(count) : formatCompact(count));
