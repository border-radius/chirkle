// Log in and sign up (DESIGN.md §22, §24.2; web/src/views/login.ts): the same fields, checks and messages. Forgot
// password (§39) asks for the email to send a reset link to; the link opens the web app's page in the browser.
package chirkle.android.feature.auth

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import chirkle.android.data.api.ApiError
import chirkle.android.data.api.SIGNUP_LOGIN_FAILED
import chirkle.android.data.api.errorMessage
import chirkle.android.data.lib.Limits
import chirkle.android.data.lib.textLength
import chirkle.android.data.repo.ChirkleServices
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

enum class AuthMode { LogIn, SignUp, Forgot }

class AuthViewModel(private val services: ChirkleServices, initial: AuthMode) : ViewModel() {
    var mode by mutableStateOf(initial)
        private set
    var name by mutableStateOf("")
    var email by mutableStateOf("")
    var password by mutableStateOf("")
    var inviteCode by mutableStateOf("")
    var busy by mutableStateOf(false)
        private set
    /** Forgot: where the reset link went, once sent ("" before). */
    var sentTo by mutableStateOf("")
        private set
    /** An error above the button: network, rate limit, a refused login. */
    var formError by mutableStateOf("")
        private set
    /** Errors next to their fields. */
    var fieldErrors by mutableStateOf(emptyMap<String, String>())
        private set

    val inviteOnly: Boolean get() = services.store.get().site.inviteOnly

    fun switch(to: AuthMode) {
        if (to == mode || busy) return
        mode = to
        sentTo = ""
        formError = ""
        fieldErrors = emptyMap()
    }

    /** The fields on screen in this mode. */
    private fun fields(): Set<String> = when (mode) {
        AuthMode.LogIn -> setOf("email", "password")
        AuthMode.Forgot -> setOf("email")
        AuthMode.SignUp -> setOf("name", "email", "password") + if (inviteOnly) setOf("invite_code") else emptySet()
    }

    fun submit() {
        if (busy) return
        formError = ""
        fieldErrors = emptyMap()
        if (mode == AuthMode.SignUp && textLength(name.trim()) > Limits.USER_NAME) {
            fieldErrors = mapOf("name" to "Must be no more than ${Limits.USER_NAME} characters.")
            return
        }
        if (mode == AuthMode.SignUp && password.length < Limits.PASSWORD_MIN) {
            fieldErrors = mapOf("password" to "Must be at least ${Limits.PASSWORD_MIN} characters.")
            return
        }
        busy = true
        viewModelScope.launch {
            try {
                when (mode) {
                    AuthMode.LogIn -> services.logIn(email.trim(), password)
                    AuthMode.SignUp -> services.signUp(email.trim(), password, name, if (inviteOnly) inviteCode.trim() else "")
                    AuthMode.Forgot -> {
                        services.requestPasswordReset(email)
                        sentTo = email.trim()
                    }
                }
                // Signed in: the app's session listener takes it from here.
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                busy = false
            }
        }
    }

    private fun fail(e: Exception) {
        if (e is ApiError && e.codes["auth"] == SIGNUP_LOGIN_FAILED) {
            // The account exists now: signing up again would only say the email is taken.
            mode = AuthMode.LogIn
            formError = "Your account was created, but logging in failed: ${errorMessage(e)} Log in to continue."
            return
        }
        val all = (e as? ApiError)?.fields.orEmpty()
        val shown = all.filterKeys { it in fields() }.toMutableMap()
        if (mode == AuthMode.SignUp && e is ApiError && e.codes["email"] == "validation_not_unique") {
            shown["email"] = "There is already an account with this email. Log in instead." // QA BUG-49
        }
        // A refused login is a 400 without field errors; PocketBase's message doesn't say why (QA BUG-40).
        val badLogin = mode == AuthMode.LogIn && e is ApiError && e.status == 400
        val invite = if (shown["invite_code"] == null) all["invite_code"] else null
        fieldErrors = shown
        formError = if (shown.isNotEmpty()) "" else invite ?: if (badLogin) "Wrong email or password." else errorMessage(e)
    }
}
