package client

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
)

// Maintenance is invoked by the trusted installer helper, outside the installed
// process chain. Ordinary launches derive their root from their own executable.
func installerCommand(args []string) int {
	if len(args) == 1 && args[0] == "capabilities" {
		fmt.Println(`{"schema":1,"physicalContext":1}`)
		return 0
	}
	if len(args) == 1 && args[0] == "context-check" {
		if err := checkInstallerContext(); err != nil {
			return fail(err)
		}
		fmt.Println(`{"status":"physical-filesystem"}`)
		return 0
	}
	if len(args) == 0 {
		return fail(errors.New("usage: launcher.exe installer <wizard-prepare|wizard-finalize|wizard-abort|uninstall|cleanup|prepare|commit|abort|path-add|path-remove|preflight-uninstall|remove-payload> --root ABS"))
	}
	fs := flag.NewFlagSet("installer", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	root := fs.String("root", "", "installation root")
	manifest := fs.String("manifest", "", "signed manifest")
	archive := fs.String("archive", "", "signed archive")
	bootstrap := fs.String("bootstrap", "", "trusted bootstrap source")
	variant := fs.String("variant", "normal", "package variant")
	channel := fs.String("channel", "stable", "release channel")
	ticket := fs.String("ticket", "", "prepared installation ticket")
	ticketOutput := fs.String("ticket-output", "", "new temporary ticket output file")
	addPath := fs.Bool("add-path", true, "add the installed command to user PATH")
	quiet := fs.Bool("quiet", false, "omit uninstall confirmation")
	parentPID := fs.Uint("parent-pid", 0, "verified uninstall parent process")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 0 {
		return fail(errors.New("invalid installer arguments"))
	}
	if args[0] == "wizard-prepare" || args[0] == "uninstall" || args[0] == "cleanup" {
		if !filepath.IsAbs(*root) || filepath.Clean(*root) != *root {
			return fail(errors.New("installation root must be a canonical absolute path"))
		}
		if err := guardPath(*root); err != nil {
			return fail(err)
		}
	} else {
		if err := validateMaintenanceRoot(*root); err != nil {
			return fail(err)
		}
	}
	if args[0] == "wizard-prepare" || args[0] == "wizard-finalize" {
		if err := checkInstallerContext(); err != nil {
			return fail(err)
		}
		if err := checkInstallerRoot(*root); err != nil {
			return fail(err)
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	var result interface{}
	switch args[0] {
	case "prepare", "wizard-prepare":
		if !filepath.IsAbs(*manifest) || !filepath.IsAbs(*archive) || !filepath.IsAbs(*bootstrap) || !filepath.IsAbs(*ticketOutput) {
			return fail(errors.New("prepare requires absolute manifest, archive, bootstrap and new ticket-output paths"))
		}
		for _, path := range []string{*manifest, *archive, *bootstrap, *ticketOutput} {
			if err := guardPath(path); err != nil {
				return fail(err)
			}
		}
		f, err := os.Open(*manifest)
		if err != nil {
			return fail(errors.New("bundled manifest unavailable"))
		}
		b, err := readCapped(f, maxEnvelope)
		f.Close()
		if err != nil {
			return fail(err)
		}
		u, err := newUpdater(*root)
		if err != nil {
			return fail(err)
		}
		var prepared installTicket
		if args[0] == "wizard-prepare" {
			prepared, err = u.wizardPrepare(ctx, *variant, *channel, b, *archive, *bootstrap, *addPath)
		} else {
			prepared, err = u.prepareInstall(ctx, *variant, *channel, b, *archive, *bootstrap)
		}
		if err != nil {
			return fail(err)
		}
		if err := writeInstallerTicket(*ticketOutput, prepared.Ticket); err != nil {
			var cleanupErr error
			if args[0] == "wizard-prepare" {
				cleanupErr = u.wizardAbort(ctx, prepared.Ticket)
			} else {
				cleanupErr = u.abortPreparedInstall(prepared.Ticket)
			}
			if cleanupErr != nil {
				return fail(fmt.Errorf("ticket output failed; pending installation requires recovery: %w", cleanupErr))
			}
			return fail(err)
		}
		result = prepared
	case "commit", "abort", "wizard-finalize", "wizard-abort":
		if *ticket == "" {
			return fail(errors.New("commit and abort require the prepared ticket"))
		}
		u, err := newUpdater(*root)
		if err != nil {
			return fail(err)
		}
		if args[0] == "wizard-finalize" {
			err = u.wizardFinalize(ctx, *ticket)
		} else if args[0] == "wizard-abort" {
			err = u.wizardAbort(ctx, *ticket)
		} else if args[0] == "commit" {
			err = u.commitPreparedInstall(ctx, *ticket)
		} else {
			err = u.abortPreparedInstall(*ticket)
		}
		if err != nil {
			return fail(err)
		}
		result = struct {
			Status string `json:"status"`
		}{args[0]}
	case "uninstall", "wizard-remove", "cleanup":
		var err error
		if args[0] == "uninstall" {
			err = launchWizardUninstall(*root, *quiet)
		} else if args[0] == "cleanup" {
			err = cleanupWizardUninstall(*root, *quiet)
		} else {
			if *parentPID == 0 || uint64(*parentPID) > uint64(1<<32-1) {
				return fail(errors.New("uninstall child requires a valid verified parent PID"))
			}
			err = finishWizardUninstall(*root, uint32(*parentPID), *quiet)
		}
		if err != nil {
			return fail(err)
		}
		// The verified child finishes asynchronously after this executable exits.
		// A successful handoff is not a claim that removal has already completed.
		result = struct {
			Status string `json:"status"`
		}{args[0] + "-started"}
	case "path-add", "path-remove":
		var status UserPathStatus
		var err error
		if args[0] == "path-add" {
			status, err = AddUserPath(*root)
		} else {
			status, err = RemoveUserPath(*root)
		}
		if err != nil {
			return fail(err)
		}
		if status.Pending {
			return fail(errors.New("PATH ownership is uncertain; entry preserved for manual repair"))
		}
		result = status
	case "preflight-uninstall", "remove-payload":
		var err error
		if args[0] == "preflight-uninstall" {
			err = preflightUninstall(*root)
		} else {
			err = removeOwnedFiles(*root)
		}
		if err != nil {
			return fail(err)
		}
		remnants, err := uninstallRemnants(*root)
		if err != nil {
			return fail(err)
		}
		result = struct {
			Status   string   `json:"status"`
			Remnants []string `json:"remnants"`
		}{args[0], remnants}
	default:
		return fail(errors.New("unknown installer operation"))
	}
	b, err := json.Marshal(result)
	if err != nil {
		return fail(err)
	}
	fmt.Println(string(b))
	return 0
}

func writeInstallerTicket(path, ticket string) error {
	if err := guardPath(path); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("ticket output must be a new writable file")
	}
	_, writeErr := io.WriteString(f, ticket+"\n")
	syncErr := f.Sync()
	closeErr := f.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return errors.New("cannot persist installer ticket output")
	}
	return nil
}

// Call under the lifetime lease; mutations additionally hold update.lock.
// A prepared installer can coexist with the old engine. A partial uninstall
// cannot: its inventory must finish recovery before dispatch or mutation.
func checkPendingMaintenance(root string, allowPrepared bool) error {
	names := []string{"uninstall-pending.json", "wizard-uninstall.json"}
	if !allowPrepared {
		names = append(names, "install-pending.json", "wizard-pending.json", "wizard-intent.json")
	}
	for _, name := range names {
		path := filepath.Join(root, "state", name)
		if err := guardMaintenancePath(path); err != nil {
			return err
		}
		if _, err := os.Lstat(path); err == nil {
			return errors.New("installation maintenance is pending; rerun its trusted installer helper to recover")
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}
