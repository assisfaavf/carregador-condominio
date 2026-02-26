import StitchPage from '../stitch/StitchPage'
import source from '../../stitch/stitch_login_screen/user_login_and_sign_up_screen/code.html?raw'

export default function LoginPage() {
  return <StitchPage pageId="login" source={source} />
}
