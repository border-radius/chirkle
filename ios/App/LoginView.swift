// Choosing a server, then logging in or signing up (§22, §24.2; android's Login screen).
import ChirkleCore
import SwiftUI

struct ServerView: View {
    @Environment(AppModel.self) private var model
    @State private var address = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("chat.example.org", text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onSubmit(go)
                } header: {
                    Text("Server")
                } footer: {
                    Text("The address of the Chirkle server you have an account on.")
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                Button(action: go) {
                    if busy { ProgressView() } else { Text("Continue") }
                }
                .disabled(busy || address.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .navigationTitle("Chirkle")
        }
    }

    private func go() {
        busy = true
        error = nil
        Task {
            do {
                try await model.setServer(address)
            } catch {
                self.error = (error as? APIError)?.message ?? Strings.cantReachThatServer
            }
            busy = false
        }
    }
}

struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var signingUp = false
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var invite = ""
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if let logo = model.site.logo {
                        AsyncImage(url: logo) { $0.resizable().scaledToFit() } placeholder: { Color.clear }
                            .frame(height: 56)
                            .frame(maxWidth: .infinity)
                    }
                    Text(model.server?.host ?? "")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                }
                .listRowBackground(Color.clear)

                Section {
                    if signingUp {
                        TextField("Name", text: $name)
                            .textContentType(.nickname)
                            .autocorrectionDisabled()
                    }
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(signingUp ? .newPassword : .password)
                    if signingUp && model.site.inviteOnly {
                        TextField("Invite code", text: $invite)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                if let notice {
                    Text(notice).foregroundStyle(.secondary)
                }
                Section {
                    Button(action: submit) {
                        if busy { ProgressView() } else { Text(signingUp ? "Sign up" : "Log in").bold() }
                    }
                    .disabled(busy || !valid)
                    Button(signingUp ? "I have an account" : "Create an account") {
                        signingUp.toggle()
                        error = nil
                    }
                    if !signingUp && model.site.passwordReset {
                        Button("Forgot password?", action: reset).disabled(email.isEmpty)
                    }
                }
                Section {
                    Button("Use another server", role: .destructive) { model.forgetServer() }
                }
            }
            .navigationTitle(model.site.title)
        }
    }

    private var valid: Bool {
        guard !email.isEmpty, password.count >= (signingUp ? Contract.Limits.passwordMin : 1) else { return false }
        if signingUp {
            let n = name.trimmingCharacters(in: .whitespaces)
            return !n.isEmpty && n.count <= Contract.Limits.userName && password.utf8.count <= Contract.Limits.passwordMaxBytes
        }
        return true
    }

    private func submit() {
        busy = true
        error = nil
        notice = nil
        Task {
            do {
                if signingUp {
                    try await model.signUp(email: email, password: password, name: name.trimmingCharacters(in: .whitespaces), inviteCode: invite)
                } else {
                    try await model.logIn(email: email, password: password)
                }
            } catch let e as APIError {
                error = signingUp ? e.reason : (e.status == 400 ? "Wrong email or password." : e.errorDescription)
            } catch {}
            busy = false
        }
    }

    private func reset() {
        Task {
            do {
                try await model.api?.requestPasswordReset(email: email)
                notice = "If \(email) has an account, a link to set a new password is on its way."
            } catch let e as APIError {
                error = e.errorDescription
            } catch {}
        }
    }
}
