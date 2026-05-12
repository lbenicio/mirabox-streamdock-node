import lldb

LOG = open("/tmp/hid_all.log", "w")


def make_handler(name):
    def handler(frame, bp_loc, dict):
        length = frame.FindRegister("x2").unsigned
        data_ptr = frame.FindRegister("x1").unsigned
        read_len = min(int(length), 1025)  # Capture FULL 1025-byte packets
        err = lldb.SBError()
        process = frame.GetThread().GetProcess()
        data = process.ReadMemory(data_ptr, read_len, err)

        if err.Success():
            hex_str = " ".join(f"{b:02x}" for b in data)
            LOG.write(f"\n{name} len={length}:\nHEX: {hex_str}\n")
        else:
            LOG.write(f"\n{name} len={length} (read failed)\n")
        LOG.flush()
        process.Continue()

    return handler


def __lldb_init_module(debugger, internal_dict):
    target = debugger.GetSelectedTarget()
    if not target:
        print("No target")
        return
    for sym in [
        "hid_write",
        "hid_read",
        "hid_send_feature_report",
        "hid_get_feature_report",
        "hid_get_input_report",
    ]:
        bp = target.BreakpointCreateByName(sym)
        if bp.IsValid() and bp.GetNumLocations() > 0:
            bp.SetScriptCallbackFunction(f"lldb_hook.{sym}_handler")
            print(f"  Hooked {sym}")
    LOG.write("=== Session start ===\n")
    LOG.flush()


for sym in [
    "hid_write",
    "hid_read",
    "hid_send_feature_report",
    "hid_get_feature_report",
    "hid_get_input_report",
]:
    globals()[f"{sym}_handler"] = make_handler(sym)
