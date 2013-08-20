/*jslint plusplus: true, vars: true, nomen: true */
/*global $, brackets, console, define, Mustache */

define(function (require, exports, module) {
    "use strict";

    exports.init = function (nodeConnection, extensionConfiguration) {

        var q                   = require("../thirdparty/q"),
            AppInit             = brackets.getModule("utils/AppInit"),
            Dialogs             = brackets.getModule("widgets/Dialogs"),
            DefaultDialogs      = brackets.getModule("widgets/DefaultDialogs"),
            DocumentManager     = brackets.getModule("document/DocumentManager"),
            PanelManager        = brackets.getModule("view/PanelManager"),
            PreferencesManager  = brackets.getModule("preferences/PreferencesManager"),
            ProjectManager      = brackets.getModule("project/ProjectManager"),
            GitControl          = require("./gitControl");

        // TODO: put this to single file to allow localization
        var Strings = {
            BUTTON_CANCEL:      "Cancel",
            BUTTON_COMMIT:      "Commit",
            BUTTON_OK:          "OK",
            BUTTON_RESET:       "Reset index",
            NOTHING_TO_COMMIT:  "Nothing to commit, working directory clean.",
            USING_GIT_VERSION:  "Using Git version"
        };

        var gitPanelTemplate        = require("text!htmlContent/git-panel.html"),
            gitPanelResultsTemplate = require("text!htmlContent/git-panel-results.html");

        var preferences         = null,
            defaultPreferences  = {};

        var extensionName           = "[brackets-git] ",
            $gitStatusBar           = $(null),
            $gitBranchName          = $(null),
            gitPanel                = null,
            $busyIndicator          = null,
            busyIndicatorIndex      = 0,
            busyIndicatorInProgress = [],
            currentProjectRoot      = ProjectManager.getProjectRoot().fullPath;

        // Seems just too buggy right now
        q.stopUnhandledRejectionTracking();

        function logError(ex) {
            console.error(extensionName + ex);
        }

        function showBusyIndicator() {
            var i = busyIndicatorIndex++;
            busyIndicatorInProgress.push(i);
            $busyIndicator.addClass("spin");
            return i;
        }

        function hideBusyIndicator(i) {
            var pos = busyIndicatorInProgress.indexOf(i);
            if (pos !== -1) {
                busyIndicatorInProgress.splice(pos, 1);
            }
            if (busyIndicatorInProgress.length === 0) {
                $busyIndicator.removeClass("spin");
            }
        }

        var gitControl = new GitControl({
            extensionConfiguration: extensionConfiguration,
            executeHandler: function (cmdString) {
                var rv = q.defer(),
                    i = showBusyIndicator();
                nodeConnection.domains["brackets-git"].executeCommand(currentProjectRoot, cmdString)
                    .then(function (out) {
                        hideBusyIndicator(i);
                        rv.resolve(out);
                    })
                    .fail(function (err) {
                        hideBusyIndicator(i);
                        rv.reject(err);
                    })
                    .done();
                return rv.promise;
            }
        });

        // Shows currently installed version or error when Git is not available
        function initGitStatusBar() {
            return gitControl.getVersion().then(function (version) {
                Strings.GIT_VERSION = version;
                $gitStatusBar.text(version);
            }).fail(function (err) {
                $gitStatusBar.addClass("error").text(err);
                throw err;
            });
        }

        // Displays branch name next to the current working folder name
        function refreshGitBranchName() {
            $gitBranchName.text("[ \u2026 ]").show();
            gitControl.getRepositoryRoot().then(function (root) {
                if (root === currentProjectRoot) {
                    gitControl.getBranchName().then(function (branchName) {
                        $gitBranchName.text("[ " + branchName + " ]");
                    }).fail(logError);
                } else {
                    $gitBranchName.text("[ not a git root ]");
                }
            }).fail(function () {
                // Current working folder is not a git repository
                $gitBranchName.text("[ not a git repo ]");
            });
        }

        function refreshGitPanel() {
            if (!gitPanel.isVisible()) {
                // no point, will be refreshed when it's displayed
                return;
            }

            gitControl.getGitStatus().then(function (files) {
                var panel = gitPanel.$panel.find(".table-container")
                    .empty();

                if (files.length === 0) {
                    // TODO: handle no files modified
                    panel.append($("<p/>").text(Strings.NOTHING_TO_COMMIT));
                } else {
                    panel.append(Mustache.render(gitPanelResultsTemplate, { files: files }));
                    gitPanel.$panel.find(".check-all").prop("checked", false);
                }
            }).fail(logError);
        }

        /* maybe later
        function handlePanelAdd() {
            // TODO: block git panel
            var promises = [];
            gitPanel.$panel.find(".check-one:checked").each(function () {
                var file = $(this).closest("tr").data("file");
                promises.push(gitControl.gitAdd(file));
            });
            q.all(promises).then(function () {
                // TODO: unblock git panel
                refreshGitPanel();
            }).fail(logError);
        }
        */

        function _commitFiles(files, message) {
            var promises = [];
            files.forEach(function (fileObj) {
                var updateIndex = false;
                if (fileObj.status.indexOf("DELETED") !== -1) {
                    updateIndex = true;
                }
                promises.push(gitControl.gitAdd(fileObj.filename, updateIndex));
            });
            return q.all(promises).then(function () {
                return gitControl.gitCommit(message);
            }).then(function () {
                return refreshGitPanel();
            });
        }

        function handleGitCommit() {
            // Get checked files
            var $checked = gitPanel.$panel.find(".check-one:checked");
            if ($checked.length === 0) { return; }

            // Open the dialog
            var dialogTemplate = require("text!htmlContent/git-commit-dialog.html"),
                compiledTemplate = Mustache.render(dialogTemplate, { Strings: Strings }),
                dialog = Dialogs.showModalDialogUsingTemplate(compiledTemplate);

            dialog.getElement().find("button.primary").on("click", function (e) {
                var commitMessage = dialog.getElement().find("input[name='commit-message']").val();
                if (commitMessage.trim().length === 0) {
                    e.stopPropagation();
                }
            });

            dialog.done(function (buttonId) {
                if (buttonId === "ok") {
                    var commitMessage = dialog.getElement().find("input[name='commit-message']").val(),
                        files = $checked.closest("tr").map(function () {
                            return {
                                filename: $(this).data("file"),
                                status:   $(this).data("status")
                            };
                        }).toArray();
                    _commitFiles(files, commitMessage).fail(logError);
                }
            });
        }

        function handleGitReset() {
            gitControl.gitReset().then(function () {
                refreshGitPanel();
            }).fail(logError);
        }

        function toggleGitPanel() {
            var enabled = gitPanel.isVisible();
            if (enabled) {
                gitPanel.hide();
            } else {
                gitPanel.show();
                refreshGitPanel();
            }
            preferences.setValue("enabled", !enabled);
        }

        // This only launches when Git is available
        function initUi() {
            // Add branch name to project tree
            $gitBranchName = $("<div id='git-branch'></div>").appendTo("#project-files-header");

            // Add toolbar icon
            var $icon = $("<a id='git-toolbar-icon' href='#'>[G]</a>")
                .appendTo($("#main-toolbar .buttons"));

            // Add panel
            var panelHtml = Mustache.render(gitPanelTemplate, Strings);
            gitPanel = PanelManager.createBottomPanel("brackets-git.panel", $(panelHtml), 100);

            // Attach events
            $icon.on("click", toggleGitPanel);

            gitPanel.$panel
                .on("click", ".close", toggleGitPanel)
                .on("click", ".check-one", function (e) {
                    e.stopPropagation();
                })
                .on("click", ".check-all", function () {
                    var isChecked = $(this).is(":checked");
                    gitPanel.$panel.find(".check-one").prop("checked", isChecked);
                })
                .on("click", ".git-reset", handleGitReset)
                .on("click", ".git-commit", handleGitCommit);

            // Show gitPanel when appropriate
            if (preferences.getValue("enabled")) {
                toggleGitPanel();
            }
        }

        // This only launches, when bash is available
        function initBashIcon() {
            $("<a id='git-bash'>[ bash ]</a>")
                .appendTo("#project-files-header")
                .on("click", function (e) {
                    e.stopPropagation();
                    gitControl.bashOpen(currentProjectRoot);
                });
        }

        // Call this only when Git is available
        function attachEventsToBrackets() {
            $(ProjectManager).on("projectOpen", function (event, projectRoot) {
                currentProjectRoot = projectRoot.fullPath;
                refreshGitBranchName();
                refreshGitPanel();
            });
            $(ProjectManager).on("projectRefresh", function () { /*event, projectRoot*/
                refreshGitBranchName();
                refreshGitPanel();
            });
            $(ProjectManager).on("beforeProjectClose", function () {
                $gitBranchName.hide();
            });
            $(ProjectManager).on("projectFilesChange", function () {
                refreshGitBranchName();
                refreshGitPanel();
            });
            $(DocumentManager).on("documentSaved", function () {
                refreshGitPanel();
            });
        }

        // Initialize PreferenceStorage.
        preferences = PreferencesManager.getPreferenceStorage(module, defaultPreferences);

        // Initialize items dependent on HTML DOM
        AppInit.htmlReady(function () {
            $gitStatusBar  = $("<div id='git-status'></div>").appendTo($("#status-indicators"));
            $busyIndicator = $("<div class='spinner'></div>").appendTo($gitStatusBar);
            initGitStatusBar().then(function () {
                attachEventsToBrackets();
                initUi();
                refreshGitBranchName();
            });
            gitControl.bashVersion().then(function () {
                initBashIcon();
            });
        });

    };
});