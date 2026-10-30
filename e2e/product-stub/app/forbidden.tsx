import { GATED_POSITION } from "../lib/config";

export default function Forbidden() {
  return <p>Missing position {GATED_POSITION}.</p>;
}
